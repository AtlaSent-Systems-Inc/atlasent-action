import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashArtifact,
  highestSeverity,
  renderStepSummary,
  runGovernanceAgents,
  type AgentFinding,
  type RunGovernanceAgentsOptions,
} from "../governanceAgents";

// ─── fs fake ────────────────────────────────────────────────────────────────

type FakeFs = NonNullable<RunGovernanceAgentsOptions["fileSystem"]>;

function makeFs(files: Record<string, string>): FakeFs {
  // Directories are derived from file paths.
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    let parent = p;
    while (true) {
      const idx = parent.lastIndexOf("/");
      if (idx <= 0) break;
      parent = parent.slice(0, idx);
      dirs.add(parent);
    }
  }
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p) || dirs.has(p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return files[p];
    },
    readdirSync: (p) => {
      const out: string[] = [];
      const prefix = p.endsWith("/") ? p : p + "/";
      for (const fp of Object.keys(files)) {
        if (fp.startsWith(prefix)) {
          const tail = fp.slice(prefix.length);
          if (!tail.includes("/")) out.push(tail);
        }
      }
      // Subdirectories.
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const tail = d.slice(prefix.length);
          if (!tail.includes("/")) out.push(tail);
        }
      }
      return [...new Set(out)];
    },
    statSync: (p) => ({
      isDirectory: () => dirs.has(p),
      isFile: () => Object.prototype.hasOwnProperty.call(files, p),
    }),
  };
}

// ─── fetch fake ─────────────────────────────────────────────────────────────

function fetchReturning(responses: Record<string, unknown>) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse((init.body as string) ?? "{}");
    calls.push({ url, body });
    // Match by slug in URL.
    const m = url.match(/agents\/([^/]+)\/evaluate$/);
    const slug = m ? decodeURIComponent(m[1]) : "";
    const payload = responses[slug] ?? {
      evaluation: {
        id: `eval-${slug}`,
        agent_slug: slug,
        agent_version: "v1",
        status: "completed",
        highest_severity: null,
        findings_count: 0,
        summary: "no findings",
      },
      findings: [],
    };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
      text: async () => "",
    } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function f(severity: AgentFinding["severity"], slug = "migration_review"): AgentFinding {
  return {
    id: `f-${severity}`,
    agent_slug: slug,
    finding_type: "x",
    severity,
    summary: `${severity} thing`,
    required_authority: "engineering",
    recommended_action: "fix it",
    evidence_refs: [],
    can_authorize: false,
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("hashArtifact", () => {
  it("is deterministic across key ordering", () => {
    const a = hashArtifact({ b: 1, a: 2 });
    const b = hashArtifact({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("differs when payload differs", () => {
    expect(hashArtifact({ a: 1 })).not.toBe(hashArtifact({ a: 2 }));
  });
});

describe("highestSeverity", () => {
  it("returns null on empty", () => {
    expect(highestSeverity([])).toBeNull();
  });
  it("picks blocker over high over info", () => {
    expect(highestSeverity([f("info"), f("blocker"), f("high")])).toBe("blocker");
  });
});

describe("runGovernanceAgents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects when changeId is missing", async () => {
    const { fetchImpl } = fetchReturning({});
    await expect(
      runGovernanceAgents({
        apiKey: "k",
        apiUrl: "http://api",
        changeId: "",
        agentSlugs: ["migration_review"],
        fetchImpl,
      }),
    ).rejects.toThrow(/changeId is required/);
  });

  it("rejects when agentSlugs is empty", async () => {
    const { fetchImpl } = fetchReturning({});
    await expect(
      runGovernanceAgents({
        apiKey: "k",
        apiUrl: "http://api",
        changeId: "c1",
        agentSlugs: [],
        fetchImpl,
      }),
    ).rejects.toThrow(/agentSlugs/);
  });

  it("auto-discovers migration files when slug is migration_review", async () => {
    const fs_ = makeFs({
      "/ws/supabase/migrations-runtime/001.sql": "CREATE TABLE x (id uuid);",
      "/ws/supabase/migrations-runtime/002.sql": "ALTER TABLE x ADD COLUMN y text;",
    });
    const { fetchImpl, calls } = fetchReturning({});
    await runGovernanceAgents({
      apiKey: "k",
      apiUrl: "http://api",
      changeId: "c1",
      agentSlugs: ["migration_review"],
      workspace: "/ws",
      fileSystem: fs_,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/governance/agents/migration_review/evaluate");
    expect(calls[0].body.change_id).toBe("c1");
    expect(calls[0].body.invoked_by_kind).toBe("service_account");
    expect(calls[0].body.artifact.migrations).toHaveLength(2);
    expect(calls[0].body.input_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("throws helpful error for non-auto-discoverable slug without artifact file", async () => {
    const fs_ = makeFs({});
    const { fetchImpl } = fetchReturning({});
    await expect(
      runGovernanceAgents({
        apiKey: "k",
        apiUrl: "http://api",
        changeId: "c1",
        agentSlugs: ["authority_boundary"],
        workspace: "/ws",
        fileSystem: fs_,
        fetchImpl,
      }),
    ).rejects.toThrow(/No artifact for agent "authority_boundary"/);
  });

  it("loads artifact from file when supplied", async () => {
    const fs_ = makeFs({
      "/ws/agents.json": JSON.stringify({
        authority_boundary: {
          change_id: "c1",
          transitions: [],
          gates: [],
          holds: [],
          grants: [],
        },
      }),
    });
    const { fetchImpl, calls } = fetchReturning({});
    await runGovernanceAgents({
      apiKey: "k",
      apiUrl: "http://api",
      changeId: "c1",
      agentSlugs: ["authority_boundary"],
      artifactFile: "agents.json",
      workspace: "/ws",
      fileSystem: fs_,
      fetchImpl,
    });
    expect(calls[0].body.artifact.transitions).toEqual([]);
  });

  it("flags 501 as a deployed-implementation gap", async () => {
    const fs_ = makeFs({
      "/ws/supabase/migrations-runtime/001.sql": "select 1;",
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 501,
      statusText: "Not Implemented",
      json: async () => ({}),
      text: async () => "no impl",
    } as unknown as Response);

    await expect(
      runGovernanceAgents({
        apiKey: "k",
        apiUrl: "http://api",
        changeId: "c1",
        agentSlugs: ["migration_review"],
        workspace: "/ws",
        fileSystem: fs_,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no in-process implementation/);
  });

  it("computes highest severity across multiple agents", async () => {
    const fs_ = makeFs({
      "/ws/supabase/migrations-runtime/001.sql": "select 1;",
      "/ws/agents.json": JSON.stringify({ authority_boundary: { gates: [] } }),
    });
    const { fetchImpl } = fetchReturning({
      migration_review: {
        evaluation: {
          id: "e1",
          agent_slug: "migration_review",
          agent_version: "v1",
          status: "completed",
          highest_severity: "medium",
          findings_count: 1,
          summary: "one medium",
        },
        findings: [f("medium", "migration_review")],
      },
      authority_boundary: {
        evaluation: {
          id: "e2",
          agent_slug: "authority_boundary",
          agent_version: "v1",
          status: "completed",
          highest_severity: "blocker",
          findings_count: 1,
          summary: "one blocker",
        },
        findings: [f("blocker", "authority_boundary")],
      },
    });

    const result = await runGovernanceAgents({
      apiKey: "k",
      apiUrl: "http://api",
      changeId: "c1",
      agentSlugs: ["migration_review", "authority_boundary"],
      artifactFile: "agents.json",
      workspace: "/ws",
      fileSystem: fs_,
      fetchImpl,
    });
    expect(result.highest_severity).toBe("blocker");
    expect(result.findings).toHaveLength(2);
    expect(result.evaluations).toHaveLength(2);
  });

  it("returns failed=true only when failOnSeverity threshold is met", async () => {
    const fs_ = makeFs({
      "/ws/supabase/migrations-runtime/001.sql": "select 1;",
    });
    const { fetchImpl } = fetchReturning({
      migration_review: {
        evaluation: {
          id: "e1",
          agent_slug: "migration_review",
          agent_version: "v1",
          status: "completed",
          highest_severity: "medium",
          findings_count: 1,
          summary: "",
        },
        findings: [f("medium", "migration_review")],
      },
    });

    // Threshold high: medium does not trip.
    const r1 = await runGovernanceAgents({
      apiKey: "k",
      apiUrl: "http://api",
      changeId: "c1",
      agentSlugs: ["migration_review"],
      workspace: "/ws",
      fileSystem: fs_,
      fetchImpl,
      failOnSeverity: "high",
    });
    expect(r1.failed).toBe(false);

    // Threshold medium: medium trips.
    const r2 = await runGovernanceAgents({
      apiKey: "k",
      apiUrl: "http://api",
      changeId: "c1",
      agentSlugs: ["migration_review"],
      workspace: "/ws",
      fileSystem: fs_,
      fetchImpl,
      failOnSeverity: "medium",
    });
    expect(r2.failed).toBe(true);

    // No threshold: never fails.
    const r3 = await runGovernanceAgents({
      apiKey: "k",
      apiUrl: "http://api",
      changeId: "c1",
      agentSlugs: ["migration_review"],
      workspace: "/ws",
      fileSystem: fs_,
      fetchImpl,
    });
    expect(r3.failed).toBe(false);
  });
});

describe("renderStepSummary", () => {
  it("renders a per-agent table when findings exist", () => {
    const md = renderStepSummary({
      evaluations: [
        {
          id: "e1",
          agent_slug: "migration_review",
          agent_version: "v1",
          status: "completed",
          highest_severity: "high",
          findings_count: 1,
          summary: "one finding",
        },
      ],
      findings: [f("high", "migration_review")],
      highest_severity: "high",
      failed: false,
    });
    expect(md).toContain("Constrained Governance Agents");
    expect(md).toContain("migration_review");
    expect(md).toContain("| high |");
    expect(md).toContain("**Overall highest severity:** `high`");
  });

  it("notes 'No findings' when empty", () => {
    const md = renderStepSummary({
      evaluations: [],
      findings: [],
      highest_severity: null,
      failed: false,
    });
    expect(md).toContain("**No findings.**");
  });
});
