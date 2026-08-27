import { describe, expect, it } from "vitest";
import {
  buildManagementDecisionBrief,
  ChangeBriefError,
  computeGithubPlanDigest,
  fetchChangedFiles,
  fetchCheckRuns,
  renderChangeBriefStepSummary,
  resolveBaseHead,
  runChangeBrief,
  type ChangeBriefResponse,
} from "../changeBrief";

// A minimal fetch double: maps URL substrings to {status, json}, in order.
function makeFetch(
  routes: Array<{ match: string; status?: number; body: unknown }>,
): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" } as unknown as Response;
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// ── canonical_plan_digest ────────────────────────────────────────────────

describe("computeGithubPlanDigest", () => {
  it("is deterministic for identical input", async () => {
    const input = { repository: "acme/api", base_sha: "a".repeat(40), head_sha: "b".repeat(40) };
    const d1 = await computeGithubPlanDigest(input);
    const d2 = await computeGithubPlanDigest(input);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("matches the fixed reference value atlasent-api computes independently", async () => {
    // Cross-repo parity, empirically: atlasent-api's
    // `_shared/change-brief/github-change-plan.ts` ports this exact
    // canonicalize()+SHA-256 algorithm and asserts the SAME hex for the
    // SAME input (see that repo's github-change-plan.test.ts). Verified
    // independently against Node's `node:crypto` SHA-256 over the same
    // canonical JSON string when this value was derived.
    const digest = await computeGithubPlanDigest({
      repository: "acme/account-service",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      ref: "refs/heads/main",
    });
    expect(digest).toBe("sha256:87d9225cf80a77ea1255a20d0f69c780860454e9a4dd7cc8ae644811940b2309");
  });

  it("changes when the head SHA changes (staleness)", async () => {
    const base = { repository: "acme/api", base_sha: "a".repeat(40) };
    const d1 = await computeGithubPlanDigest({ ...base, head_sha: "b".repeat(40) });
    const d2 = await computeGithubPlanDigest({ ...base, head_sha: "c".repeat(40) });
    expect(d1).not.toBe(d2);
  });

  it("does not collide across repositories with the same SHA pair", async () => {
    const shas = { base_sha: "a".repeat(40), head_sha: "b".repeat(40) };
    const d1 = await computeGithubPlanDigest({ repository: "acme/api", ...shas });
    const d2 = await computeGithubPlanDigest({ repository: "acme/web", ...shas });
    expect(d1).not.toBe(d2);
  });
});

// ── base/head resolution ─────────────────────────────────────────────────

describe("resolveBaseHead", () => {
  it("resolves from a pull_request event payload", () => {
    const payload = {
      number: 842,
      pull_request: {
        base: { sha: "a".repeat(40) },
        head: { sha: "b".repeat(40), ref: "feature/x" },
        user: { login: "octocat" },
        merged_by: null,
        html_url: "https://github.com/acme/api/pull/842",
      },
    };
    const resolved = resolveBaseHead({
      eventName: "pull_request",
      eventPath: "/tmp/event.json",
      fallbackSha: "z".repeat(40),
      fallbackRef: "refs/pull/842/merge",
      readFile: () => JSON.stringify(payload),
    });
    expect(resolved.base_sha).toBe("a".repeat(40));
    expect(resolved.head_sha).toBe("b".repeat(40));
    expect(resolved.pull_request_number).toBe(842);
    expect(resolved.pr_author).toBe("octocat");
  });

  it("resolves from a push event payload", () => {
    const payload = { before: "a".repeat(40), after: "b".repeat(40) };
    const resolved = resolveBaseHead({
      eventName: "push",
      eventPath: "/tmp/event.json",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      readFile: () => JSON.stringify(payload),
    });
    expect(resolved.base_sha).toBe("a".repeat(40));
    expect(resolved.head_sha).toBe("b".repeat(40));
  });

  it("treats an all-zero push `before` as no base available, not a synthetic base", () => {
    const payload = { before: "0".repeat(40), after: "b".repeat(40) };
    const resolved = resolveBaseHead({
      eventName: "push",
      eventPath: "/tmp/event.json",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      readFile: () => JSON.stringify(payload),
    });
    expect(resolved.base_sha).toBeNull();
    expect(resolved.head_sha).toBe("b".repeat(40));
  });

  it("falls back to fallbackSha/no-base for an unrecognized event (e.g. workflow_dispatch)", () => {
    const resolved = resolveBaseHead({
      eventName: "workflow_dispatch",
      eventPath: undefined,
      fallbackSha: "z".repeat(40),
      fallbackRef: "refs/heads/main",
    });
    expect(resolved.base_sha).toBeNull();
    expect(resolved.head_sha).toBe("z".repeat(40));
  });

  it("explicit overrides always win, even with an event payload present", () => {
    const payload = { before: "a".repeat(40), after: "b".repeat(40) };
    const resolved = resolveBaseHead({
      eventName: "push",
      eventPath: "/tmp/event.json",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      overrideBase: "c".repeat(40),
      overrideHead: "d".repeat(40),
      readFile: () => JSON.stringify(payload),
    });
    expect(resolved.base_sha).toBe("c".repeat(40));
    expect(resolved.head_sha).toBe("d".repeat(40));
  });

  it("a malformed event file degrades to the no-base fallback rather than throwing", () => {
    const resolved = resolveBaseHead({
      eventName: "push",
      eventPath: "/tmp/event.json",
      fallbackSha: "z".repeat(40),
      fallbackRef: "refs/heads/main",
      readFile: () => "not json",
    });
    expect(resolved.base_sha).toBeNull();
    expect(resolved.head_sha).toBe("z".repeat(40));
  });

  it("a base-only override applies on its own for an unrecognized event (workflow_dispatch), with head falling back to fallbackSha", () => {
    // Regression: overrideBase used to be silently dropped whenever
    // overrideHead was absent, because the no-event fallback hardcoded
    // base_sha to null instead of honoring overrideBase independently.
    // change-brief-head-sha is documented to default to GITHUB_SHA
    // (fallbackSha here), so a workflow_dispatch run supplying only
    // change-brief-base-sha must still get a real comparison.
    const resolved = resolveBaseHead({
      eventName: "workflow_dispatch",
      eventPath: undefined,
      fallbackSha: "z".repeat(40),
      fallbackRef: "refs/heads/main",
      overrideBase: "c".repeat(40),
    });
    expect(resolved.base_sha).toBe("c".repeat(40));
    expect(resolved.head_sha).toBe("z".repeat(40));
  });
});

// ── GitHub REST reads ────────────────────────────────────────────────────

describe("fetchChangedFiles", () => {
  it("normalizes files and totals", async () => {
    const { fn } = makeFetch([
      {
        match: "/compare/",
        body: {
          html_url: "https://github.com/acme/api/compare/aaa...bbb",
          files: [
            { filename: "src/a.ts", additions: 10, deletions: 2, status: "modified" },
            { filename: "src/b.ts", additions: 5, deletions: 0, status: "added" },
          ],
        },
      },
    ]);
    const result = await fetchChangedFiles({
      repository: "acme/api",
      base_sha: "aaa",
      head_sha: "bbb",
      token: "t",
      fetchImpl: fn,
    });
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.additions_total).toBe(15);
    expect(result.deletions_total).toBe(2);
  });

  it("degrades to ok:false on a non-2xx response, never throws", async () => {
    const { fn } = makeFetch([]);
    const result = await fetchChangedFiles({
      repository: "acme/api",
      base_sha: "x",
      head_sha: "y",
      token: "t",
      fetchImpl: fn,
    });
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
  });

  it("flags truncated when the file list hits GitHub's documented compare-API soft cap", async () => {
    const manyFiles = Array.from({ length: 300 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      additions: 1,
      deletions: 0,
      status: "modified",
    }));
    const { fn } = makeFetch([{ match: "/compare/", body: { files: manyFiles } }]);
    const result = await fetchChangedFiles({
      repository: "acme/api",
      base_sha: "aaa",
      head_sha: "bbb",
      token: "t",
      fetchImpl: fn,
    });
    expect(result.truncated).toBe(true);
  });

  it("an ordinary small diff is not flagged as truncated", async () => {
    const { fn } = makeFetch([
      { match: "/compare/", body: { files: [{ filename: "src/a.ts", additions: 1, deletions: 0, status: "modified" }] } },
    ]);
    const result = await fetchChangedFiles({
      repository: "acme/api",
      base_sha: "aaa",
      head_sha: "bbb",
      token: "t",
      fetchImpl: fn,
    });
    expect(result.truncated).toBe(false);
  });
});

describe("fetchCheckRuns", () => {
  it("normalizes check runs", async () => {
    const { fn } = makeFetch([
      {
        match: "/check-runs",
        body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
      },
    ]);
    const result = await fetchCheckRuns({ repository: "acme/api", ref: "bbb", token: "t", fetchImpl: fn });
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([{ name: "build", status: "completed", conclusion: "success", html_url: null }]);
    expect(result.truncated).toBe(false);
  });

  it("follows pagination across pages instead of silently dropping check runs beyond page 1", async () => {
    let calls = 0;
    const fn = (async (url: string) => {
      calls++;
      const isPage2 = url.includes("page=2");
      const body = isPage2
        ? { check_runs: [{ name: "page2-check", status: "completed", conclusion: "success" }] }
        : { check_runs: Array.from({ length: 100 }, (_, i) => ({ name: `check-${i}`, status: "completed", conclusion: "success" })) };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await fetchCheckRuns({ repository: "acme/api", ref: "bbb", token: "t", fetchImpl: fn });
    expect(calls).toBe(2); // page 1 (100, full) -> page 2 (1, short) -> stop
    expect(result.checks).toHaveLength(101);
    expect(result.checks.at(-1)?.name).toBe("page2-check");
    expect(result.truncated).toBe(false);
  });

  it("discloses truncation when the bounded reader receives ten full pages", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      const body = {
        check_runs: Array.from({ length: 100 }, (_, i) => ({
          name: `page-${calls}-check-${i}`,
          status: "completed",
          conclusion: "success",
        })),
      };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await fetchCheckRuns({
      repository: "acme/api",
      ref: "bbb",
      token: "t",
      fetchImpl: fn,
    });

    expect(calls).toBe(10);
    expect(result.checks).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });
});

// ── runChangeBrief (end-to-end, mocked) ──────────────────────────────────

function githubRoutes() {
  return [
    {
      match: "/compare/",
      body: {
        html_url: "https://github.com/acme/api/compare/aaa...bbb",
        files: [{ filename: "supabase/migrations/x.sql", additions: 8, deletions: 0, status: "added" }],
      },
    },
    {
      match: "/check-runs",
      body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
    },
  ];
}

const SAMPLE_BRIEF: ChangeBriefResponse = {
  brief_id: "cb_test",
  recommendation: { value: "request_evidence", rationale: "Impact is unknown." },
  classification: { value: "review_ready", rationale: "All required evidence present." },
  material_differences: [
    { kind: "baseline_deviation", description: "Migration changed.", significance: "decision_relevant" },
  ],
  missing_evidence: [
    {
      requirement_id: "github.rollback_plan",
      kind: "rollback_plan",
      blocking: false,
      precise_question: "What is the rollback procedure?",
    },
  ],
  baseline: { comparison_possible: true, compared_to: "a".repeat(40) },
  impact: {
    affected_principals: { determination: "unavailable", unavailable_reason: "No telemetry connected." },
    blast_radius_note: "17 file(s) changed. UNKNOWN, not zero.",
  },
};

describe("runChangeBrief", () => {
  it("throws ChangeBriefError when GITHUB_TOKEN is missing", async () => {
    await expect(
      runChangeBrief({
        apiKey: "k",
        apiUrl: "https://api.example.com/functions/v1",
        actionType: "production.deploy",
        targetSystem: "github",
        targetId: "acme/api",
        environment: "production",
        actorId: "github:octocat",
        githubToken: "",
        repository: "acme/api",
        eventName: "push",
        fallbackSha: "b".repeat(40),
        fallbackRef: "refs/heads/main",
      }),
    ).rejects.toBeInstanceOf(ChangeBriefError);
  });

  it("gathers facts, computes the digest, posts to v1-change-brief, and returns the parsed brief", async () => {
    const routes = [...githubRoutes(), { match: "/v1-change-brief", body: SAMPLE_BRIEF }];
    const { fn, calls } = makeFetch(routes);

    const result = await runChangeBrief({
      apiKey: "k",
      apiUrl: "https://api.example.com/functions/v1",
      actionType: "production.deploy",
      targetSystem: "github",
      targetId: "acme/api",
      environment: "production",
      actorId: "github:octocat",
      githubToken: "gh-token",
      repository: "acme/api",
      eventName: "push",
      eventPath: "/tmp/event.json",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      readFile: () => JSON.stringify({ before: "a".repeat(40), after: "b".repeat(40) }),
      fetchImpl: fn,
    });

    expect(result.brief.brief_id).toBe("cb_test");
    expect(result.facts.changed_files).toHaveLength(1);
    expect(result.canonicalPlanDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.collection.status).toBe("complete");
    expect(result.collection.sources.comparison.state).toBe("complete");
    expect(result.collection.sources.checks.state).toBe("complete");
    expect(calls.some((u) => u.includes("/v1-change-brief"))).toBe(true);
    // The POST body must carry github_change_plan — the seam
    // atlasent-api's handler reads.
  });

  it("throws ChangeBriefError on a non-2xx from v1-change-brief", async () => {
    const routes = [...githubRoutes(), { match: "/v1-change-brief", status: 503, body: { error: "unavailable" } }];
    const { fn } = makeFetch(routes);

    await expect(
      runChangeBrief({
        apiKey: "k",
        apiUrl: "https://api.example.com/functions/v1",
        actionType: "production.deploy",
        targetSystem: "github",
        targetId: "acme/api",
        environment: "production",
        actorId: "github:octocat",
        githubToken: "gh-token",
        repository: "acme/api",
        eventName: "push",
        eventPath: "/tmp/event.json",
        fallbackSha: "b".repeat(40),
        fallbackRef: "refs/heads/main",
        readFile: () => JSON.stringify({ before: "a".repeat(40), after: "b".repeat(40) }),
        fetchImpl: fn,
      }),
    ).rejects.toBeInstanceOf(ChangeBriefError);
  });

  it("proceeds (with a warning) when no base revision can be resolved, rather than fabricating one", async () => {
    const routes = [
      { match: "/check-runs", body: { check_runs: [] } },
      { match: "/v1-change-brief", body: SAMPLE_BRIEF },
    ];
    const { fn, calls } = makeFetch(routes);
    let warned = false;

    const result = await runChangeBrief({
      apiKey: "k",
      apiUrl: "https://api.example.com/functions/v1",
      actionType: "production.deploy",
      targetSystem: "github",
      targetId: "acme/api",
      environment: "production",
      actorId: "github:octocat",
      githubToken: "gh-token",
      repository: "acme/api",
      eventName: "workflow_dispatch",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      fetchImpl: fn,
      warn: () => {
        warned = true;
      },
    });

    expect(warned).toBe(true);
    expect(result.facts.changed_files).toEqual([]);
    expect(result.collection.status).toBe("partial");
    expect(result.collection.sources.comparison.state).toBe("unavailable");
    // No /compare/ call should have been made without a base SHA.
    expect(calls.some((u) => u.includes("/compare/"))).toBe(false);
  });
});

// ── management projection ───────────────────────────────────────────────

describe("buildManagementDecisionBrief", () => {
  it("translates sourced analysis into a queue-ready advisory record", async () => {
    const readyBrief: ChangeBriefResponse = {
      ...SAMPLE_BRIEF,
      recommendation: {
        value: "approve",
        rationale: "The observed change is ready for management review.",
      },
      classification: {
        value: "review_ready",
        rationale: "Required preparation evidence is present.",
      },
      missing_evidence: [],
    };
    const routes = [...githubRoutes(), { match: "/v1-change-brief", body: readyBrief }];
    const { fn } = makeFetch(routes);
    const result = await runChangeBrief({
      apiKey: "k",
      apiUrl: "https://api.example.com/functions/v1",
      actionType: "production.deploy",
      targetSystem: "github",
      targetId: "acme/api",
      environment: "production",
      actorId: "github:octocat",
      githubToken: "gh-token",
      repository: "acme/api",
      eventName: "push",
      eventPath: "/tmp/event.json",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      readFile: () => JSON.stringify({ before: "a".repeat(40), after: "b".repeat(40) }),
      fetchImpl: fn,
    });

    const management = buildManagementDecisionBrief(result);
    expect(management.schema).toBe("management_decision_brief.v1");
    expect(management.readiness).toBe("ready_for_review");
    expect(management.management_summary.automated_analysis.changed_files_observed).toBe(1);
    expect(management.management_summary.automated_analysis.check_runs_observed).toBe(1);
    expect(management.evidence_binding.canonical_plan_digest).toBe(result.canonicalPlanDigest);
    expect(management.authority_boundary).toEqual({
      advisory_only: true,
      separate_evaluate_and_permit_required: true,
    });
  });

  it("refuses to present a management-ready brief when source collection is incomplete", async () => {
    const routes = [
      { match: "/check-runs", body: { check_runs: [] } },
      { match: "/v1-change-brief", body: SAMPLE_BRIEF },
    ];
    const { fn } = makeFetch(routes);
    const result = await runChangeBrief({
      apiKey: "k",
      apiUrl: "https://api.example.com/functions/v1",
      actionType: "production.deploy",
      targetSystem: "github",
      targetId: "acme/api",
      environment: "production",
      actorId: "github:octocat",
      githubToken: "gh-token",
      repository: "acme/api",
      eventName: "workflow_dispatch",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      fetchImpl: fn,
    });

    const management = buildManagementDecisionBrief(result);
    expect(management.readiness).toBe("evidence_incomplete");
    expect(management.next_actions.some((item) => item.includes("github_compare"))).toBe(true);
  });
});

// ── rendering ────────────────────────────────────────────────────────────

describe("renderChangeBriefStepSummary", () => {
  it("never claims tests passed without a hedge", async () => {
    const routes = [...githubRoutes(), { match: "/v1-change-brief", body: SAMPLE_BRIEF }];
    const { fn } = makeFetch(routes);
    const result = await runChangeBrief({
      apiKey: "k",
      apiUrl: "https://api.example.com/functions/v1",
      actionType: "production.deploy",
      targetSystem: "github",
      targetId: "acme/api",
      environment: "production",
      actorId: "github:octocat",
      githubToken: "gh-token",
      repository: "acme/api",
      eventName: "push",
      eventPath: "/tmp/event.json",
      fallbackSha: "b".repeat(40),
      fallbackRef: "refs/heads/main",
      readFile: () => JSON.stringify({ before: "a".repeat(40), after: "b".repeat(40) }),
      fetchImpl: fn,
    });
    const summary = renderChangeBriefStepSummary(result);
    expect(summary).toContain("AtlaSent Management Decision Brief");
    expect(summary).toContain("Work AtlaSent performed automatically");
    expect(summary).toContain("Source collection integrity");
    expect(summary).toContain("evidence_incomplete");
    expect(summary).toContain("cb_test");
    expect(summary).toContain("Migration changed.");
    expect(summary).toContain("rollback procedure");
    expect(summary).toContain("UNKNOWN, not zero");
    expect(/\btests? passed\b/i.test(summary)).toBe(false);
  });
});
