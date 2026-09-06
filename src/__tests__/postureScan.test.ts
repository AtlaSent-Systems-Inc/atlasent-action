import { describe, expect, it } from "vitest";
import {
  renderPostureStepSummary,
  runPostureScan,
  type PostureFinding,
  type PostureScanOptions,
} from "../postureScan";

// ─── fs fake (mirrors governanceAgents.test.ts's makeFs) ───────────────────
//
// Every test uses workspace "/ws". By default the fake fs includes a
// "/ws/.git/HEAD" entry so it looks like a real `actions/checkout` happened
// (the marker postureScan.ts uses to distinguish "genuinely absent" from
// "there was nothing to check"). Pass `{ checkedOut: false }` to simulate a
// step that ran with no preceding checkout at all.

type FakeFs = NonNullable<PostureScanOptions["fileSystem"]>;

function makeFs(files: Record<string, string>, opts: { checkedOut?: boolean } = {}): FakeFs {
  const checkedOut = opts.checkedOut ?? true;
  const allFiles: Record<string, string> = checkedOut
    ? { "/ws/.git/HEAD": "ref: refs/heads/main\n", ...files }
    : { ...files };

  const dirs = new Set<string>();
  for (const p of Object.keys(allFiles)) {
    let parent = p;
    while (true) {
      const idx = parent.lastIndexOf("/");
      if (idx <= 0) break;
      parent = parent.slice(0, idx);
      dirs.add(parent);
    }
  }
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(allFiles, p) || dirs.has(p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(allFiles, p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return allFiles[p];
    },
    readdirSync: (p) => {
      const out: string[] = [];
      const prefix = p.endsWith("/") ? p : p + "/";
      for (const fp of Object.keys(allFiles)) {
        if (fp.startsWith(prefix)) {
          const tail = fp.slice(prefix.length);
          if (!tail.includes("/")) out.push(tail);
        }
      }
      return [...new Set(out)];
    },
  };
}

// Checked out, nothing else present — the baseline "genuinely absent" fixture.
const NO_FILES = makeFs({});
// No preceding actions/checkout at all — everything must read as unknown, never absent.
const NOT_CHECKED_OUT = makeFs({}, { checkedOut: false });

// ─── fetch fake: routes by exact-suffix match, in the order provided ───────

interface Route {
  match: RegExp;
  status: number;
  body?: unknown;
  text?: string;
}

function fetchRouting(routes: Route[]): typeof fetch {
  return (async (url: string) => {
    const route = routes.find((r) => r.match.test(url));
    if (!route) {
      throw new Error(`no fetch route matched: ${url}`);
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body ?? {},
      text: async () => route.text ?? JSON.stringify(route.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function find(findings: PostureFinding[], id: string): PostureFinding {
  const f = findings.find((x) => x.id === id);
  if (!f) throw new Error(`no finding with id ${id}`);
  return f;
}

const REPO_URL = /\/repos\/acme\/widgets$/;
const PROTECTION_URL = /\/branches\/main\/protection$/;
const ALERTS_URL = /\/vulnerability-alerts$/;
const ORG_URL = /\/orgs\/acme$/;

const ALL_API_SIGNAL_IDS = [
  "branch_protection",
  "required_status_checks",
  "secret_scanning",
  "secret_scanning_push_protection",
  "dependabot_security_updates",
  "dependabot_alerts_enabled",
  "org_2fa_enforcement",
  "org_sso_enforcement",
];

// ─── filesystem signals ─────────────────────────────────────────────────────

describe("runPostureScan — filesystem-based signals", () => {
  it("reports CODEOWNERS / dependabot config / CodeQL workflow as present when found", async () => {
    const fs_ = makeFs({
      "/ws/.github/CODEOWNERS": "* @acme/eng\n",
      "/ws/.github/dependabot.yml": "version: 2\n",
      "/ws/.github/workflows/codeql.yml": "uses: github/codeql-action/analyze@v3\n",
    });
    const result = await runPostureScan({ workspace: "/ws", fileSystem: fs_, repository: "", token: "" });

    const codeowners = find(result.findings, "codeowners");
    expect(codeowners.observable).toBe(true);
    expect(codeowners.status).toBe("present");
    expect(codeowners.reason).toBe("observed");

    const dependabot = find(result.findings, "dependabot_config");
    expect(dependabot.status).toBe("present");

    const codeql = find(result.findings, "codeql_workflow");
    expect(codeql.status).toBe("present");
    expect(codeql.evidence?.matched_files).toEqual(["codeql.yml"]);
  });

  it("reports absent (never unknown) when files genuinely don't exist in a checked-out tree", async () => {
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "", token: "" });

    for (const id of ["codeowners", "dependabot_config", "codeql_workflow"]) {
      const f = find(result.findings, id);
      expect(f.observable).toBe(true);
      expect(f.status).toBe("absent");
      expect(f.reason).toBe("observed");
    }
  });

  it("does not flag a workflow file as CodeQL just because a workflows dir exists with unrelated files", async () => {
    const fs_ = makeFs({
      "/ws/.github/workflows/lint.yml": "run: npm run lint\n",
    });
    const result = await runPostureScan({ workspace: "/ws", fileSystem: fs_, repository: "", token: "" });
    const codeql = find(result.findings, "codeql_workflow");
    expect(codeql.status).toBe("absent");
    expect(codeql.evidence?.workflow_files_scanned).toEqual(["lint.yml"]);
  });

  // Regression test for the CodeQL false-positive fix: a bare mention of the
  // word "codeql" (in a job name, comment, or unrelated step) must NOT be
  // read as "CodeQL is configured". Only an actual `uses:` step reference
  // to the CodeQL Action counts.
  it("does not match a bare 'codeql' word mention — only an actual uses: step reference counts", async () => {
    const fs_ = makeFs({
      "/ws/.github/workflows/scan.yml": [
        "name: My CodeQL-flavored pipeline",
        "jobs:",
        "  scan:",
        "    steps:",
        "      # We considered codeql here but use a different scanner.",
        "      - name: codeql-mention-in-name",
        "        run: echo 'not actually codeql'",
        "      - uses: some-org/unrelated-action@v1",
        "",
      ].join("\n"),
    });
    const result = await runPostureScan({ workspace: "/ws", fileSystem: fs_, repository: "", token: "" });
    const codeql = find(result.findings, "codeql_workflow");
    expect(codeql.status).toBe("absent");
    expect(codeql.evidence?.matched_files).toEqual([]);
  });

  it("still matches quoted / single-quoted uses: forms for the CodeQL Action", async () => {
    const fs_ = makeFs({
      "/ws/.github/workflows/codeql.yml": "      - uses: 'github/codeql-action/init@v3'\n",
    });
    const result = await runPostureScan({ workspace: "/ws", fileSystem: fs_, repository: "", token: "" });
    expect(find(result.findings, "codeql_workflow").status).toBe("present");
  });

  // Regression tests for the "no checkout happened" fix: a genuinely absent
  // file and a workspace with nothing checked out at all must be
  // distinguishable — the latter must NEVER report "absent".
  describe("when the workspace was never checked out (no .git)", () => {
    it("reports codeowners / dependabot_config / codeql_workflow as unknown, never absent", async () => {
      const result = await runPostureScan({ workspace: "/ws", fileSystem: NOT_CHECKED_OUT, repository: "", token: "" });
      for (const id of ["codeowners", "dependabot_config", "codeql_workflow"]) {
        const f = find(result.findings, id);
        expect(f.observable).toBe(false);
        expect(f.status).toBe("unknown");
        expect(f.reason).toBe("workspace_not_checked_out");
        expect(f.detail).toMatch(/actions\/checkout/);
      }
    });

    it("still reports present if the file genuinely exists, even without a .git marker", async () => {
      // Edge case: something placed the file there without a real checkout
      // (e.g. a synthetic test harness). A real positive finding must still
      // win — the checkout guard only matters for the ambiguous "not found" case.
      const fs_ = makeFs({ "/ws/.github/CODEOWNERS": "* @acme/eng\n" }, { checkedOut: false });
      const result = await runPostureScan({ workspace: "/ws", fileSystem: fs_, repository: "", token: "" });
      const codeowners = find(result.findings, "codeowners");
      expect(codeowners.status).toBe("present");
      expect(codeowners.reason).toBe("observed");
    });
  });
});

// ─── missing repository / token ─────────────────────────────────────────────

describe("runPostureScan — missing repository or token", () => {
  it("marks every API-based signal check_failed when repository is empty", async () => {
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "", token: "tok" });
    const branchProtection = find(result.findings, "branch_protection");
    expect(branchProtection.observable).toBe(false);
    expect(branchProtection.reason).toBe("check_failed");
  });

  it("marks every API-based signal 'no_token' — never guesses — when GITHUB_TOKEN is absent", async () => {
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "" });
    for (const id of ALL_API_SIGNAL_IDS) {
      const f = find(result.findings, id);
      expect(f.observable).toBe(false);
      expect(f.status).toBe("unknown");
      expect(f.reason).toBe("no_token");
    }
    // Filesystem signals are unaffected by the missing token.
    expect(find(result.findings, "codeowners").reason).toBe("observed");
  });
});

// ─── branch protection / required status checks ────────────────────────────

describe("runPostureScan — branch protection", () => {
  it("reports present with real evidence when protection is configured (HTTP 200)", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" }, security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" }, dependabot_security_updates: { status: "disabled" } } } },
      {
        match: PROTECTION_URL,
        status: 200,
        body: {
          required_status_checks: { strict: true, contexts: ["ci/build"] },
          enforce_admins: { enabled: true },
          required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, dismiss_stale_reviews: true },
          allow_force_pushes: { enabled: false },
        },
      },
      { match: ALERTS_URL, status: 204 },
      { match: ORG_URL, status: 200, body: { two_factor_requirement_enabled: true } },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });

    const bp = find(result.findings, "branch_protection");
    expect(bp.observable).toBe(true);
    expect(bp.status).toBe("present");
    expect(bp.reason).toBe("observed");
    expect(bp.evidence?.required_approving_review_count).toBe(2);

    const rsc = find(result.findings, "required_status_checks");
    expect(rsc.status).toBe("present");
    expect(rsc.evidence?.contexts).toEqual(["ci/build"]);
  });

  it("reports absent (both branch_protection and required_status_checks) on a genuine 'Branch not protected' 404", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 404, text: JSON.stringify({ message: "Branch not protected" }) },
      { match: ALERTS_URL, status: 404 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });

    expect(find(result.findings, "branch_protection").status).toBe("absent");
    expect(find(result.findings, "required_status_checks").status).toBe("absent");
  });

  it("reports unknown/insufficient_permission on the real 403 'Resource not accessible by integration' shape, with REMEDIATION that never claims administration:read is a valid permissions: key", async () => {
    // This is the exact response body empirically observed against the live
    // GitHub REST API for a token lacking the Administration permission.
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      {
        match: PROTECTION_URL,
        status: 403,
        text: JSON.stringify({
          message: "Resource not accessible by integration",
          documentation_url: "https://docs.github.com/rest/branches/branch-protection#get-branch-protection",
        }),
      },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });

    const bp = find(result.findings, "branch_protection");
    expect(bp.observable).toBe(false);
    expect(bp.status).toBe("unknown");
    expect(bp.reason).toBe("insufficient_permission");
    expect(bp.detail).toMatch(/Administration/);
    // Regression for the P1 fix: `administration` is NOT a valid workflow
    // `permissions:` key (confirmed against GitHub's own workflow-syntax
    // schema) — the detail must never tell a caller to add it there.
    expect(bp.detail).not.toMatch(/permissions:\s*\n?\s*administration:\s*read/i);
    expect(bp.detail).not.toMatch(/Add `permissions/i);
    // It must instead point at the real remediation: a differently-scoped
    // credential via posture-scan-token.
    expect(bp.detail).toMatch(/posture-scan-token/);

    const rsc = find(result.findings, "required_status_checks");
    expect(rsc.observable).toBe(false);
    expect(rsc.reason).toBe("insufficient_permission");
  });

  it("never conflates an ambiguous 404 (e.g. branch not found) with 'unprotected'", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 404, text: JSON.stringify({ message: "Branch not found" }) },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const bp = find(result.findings, "branch_protection");
    expect(bp.status).toBe("unknown");
    expect(bp.reason).toBe("check_failed");
  });
});

// ─── secret scanning family ──────────────────────────────────────────────────

describe("runPostureScan — secret scanning / push protection / dependabot security updates", () => {
  it("reports real per-feature status when security_and_analysis is present", async () => {
    const fetchImpl = fetchRouting([
      {
        match: REPO_URL,
        status: 200,
        body: {
          default_branch: "main",
          owner: { type: "Organization" },
          security_and_analysis: {
            secret_scanning: { status: "enabled" },
            secret_scanning_push_protection: { status: "disabled" },
            dependabot_security_updates: { status: "enabled" },
          },
        },
      },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });

    expect(find(result.findings, "secret_scanning").status).toBe("present");
    expect(find(result.findings, "secret_scanning_push_protection").status).toBe("absent");
    expect(find(result.findings, "dependabot_security_updates").status).toBe("present");
  });

  it("reports unknown/insufficient_permission — never 'absent' — when security_and_analysis is silently omitted", async () => {
    // Empirically confirmed live: GET /repos/{owner}/{repo} returns 200 with
    // the key simply missing when the token lacks admin-level access. There
    // is no error to catch here — this is the trap the code must not fall into.
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });

    for (const id of ["secret_scanning", "secret_scanning_push_protection", "dependabot_security_updates"]) {
      const f = find(result.findings, id);
      expect(f.observable).toBe(false);
      expect(f.status).toBe("unknown");
      expect(f.reason).toBe("insufficient_permission");
      // The detail must clarify absence is NOT evidence of a disabled feature.
      expect(f.detail).toMatch(/NOT evidence/i);
    }
  });

  it("marks the repo-GET-derived signals insufficient_permission when the base repo GET itself 403s", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 403, text: JSON.stringify({ message: "Resource not accessible by integration" }) },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    expect(find(result.findings, "secret_scanning").reason).toBe("insufficient_permission");
  });
});

// ─── dependabot alerts enabled (distinct from config-file presence) ────────

describe("runPostureScan — dependabot alerts enabled/disabled", () => {
  it("204 -> present", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 204 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    expect(find(result.findings, "dependabot_alerts_enabled").status).toBe("present");
  });

  it("404 -> absent, ONLY once repo visibility with this credential is independently confirmed", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 404 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const f = find(result.findings, "dependabot_alerts_enabled");
    expect(f.status).toBe("absent");
    expect(f.reason).toBe("observed");
    expect(f.detail).toMatch(/independently confirmed/);
  });

  // Regression test for the P2 fix: GitHub also 404s vulnerability-alerts
  // when the repository itself isn't visible to the credential (expired,
  // misscoped, or wrong token) — that must NEVER be read as "disabled"
  // without independent confirmation that the repo is actually visible.
  it("404 -> unknown/check_failed (never 'absent') when the base repo GET itself failed for this credential", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 403, text: JSON.stringify({ message: "Bad credentials" }) },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 404 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const f = find(result.findings, "dependabot_alerts_enabled");
    expect(f.observable).toBe(false);
    expect(f.status).toBe("unknown");
    expect(f.reason).toBe("check_failed");
    expect(f.detail).toMatch(/not visible|not independently confirmed|repository itself/i);
  });

  it("403 -> unknown/insufficient_permission, distinct from dependabot_config file check", async () => {
    const fs_ = makeFs({ "/ws/.github/dependabot.yml": "version: 2\n" });
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403, text: JSON.stringify({ message: "Resource not accessible by integration" }) },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: fs_, repository: "acme/widgets", token: "tok", fetchImpl });

    const alertsEnabled = find(result.findings, "dependabot_alerts_enabled");
    expect(alertsEnabled.status).toBe("unknown");
    expect(alertsEnabled.reason).toBe("insufficient_permission");
    // The config-file signal is a completely different, still-observable check.
    expect(find(result.findings, "dependabot_config").status).toBe("present");
  });
});

// ─── org-level 2FA and SSO enforcement (now two independent findings) ──────

describe("runPostureScan — org 2FA enforcement (org_2fa_enforcement)", () => {
  it("reports a real result when the org endpoint genuinely returns the field", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 200, body: { two_factor_requirement_enabled: false } },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const f = find(result.findings, "org_2fa_enforcement");
    expect(f.observable).toBe(true);
    expect(f.status).toBe("absent");
    expect(f.reason).toBe("observed");
  });

  it("reports present when the org requires 2FA", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 200, body: { two_factor_requirement_enabled: true } },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    expect(find(result.findings, "org_2fa_enforcement").status).toBe("present");
  });

  it("reports not_observable_by_repo_token on the structural 403 a repo token gets", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 403, text: JSON.stringify({ message: "Must have admin rights to Organization." }) },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const f = find(result.findings, "org_2fa_enforcement");
    expect(f.observable).toBe(false);
    expect(f.status).toBe("unknown");
    expect(f.reason).toBe("not_observable_by_repo_token");
  });

  it("reports not_applicable for a user-owned repository, not unknown", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "User" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      // No org route needed — the owner-type short-circuit must fire before any org call.
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const f = find(result.findings, "org_2fa_enforcement");
    expect(f.status).toBe("not_applicable");
    expect(f.reason).toBe("not_applicable");
  });
});

describe("runPostureScan — org SSO enforcement (org_sso_enforcement) — independent of 2FA", () => {
  // Regression test for the P2 conflation fix: an org that requires 2FA but
  // does NOT enforce SSO must never show SSO as "present" just because 2FA
  // is. SSO is always its own, separately-reasoned finding.
  it("is never inferred from a 2FA=true result — always its own honest unknown", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 200, body: { two_factor_requirement_enabled: true } },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });

    expect(find(result.findings, "org_2fa_enforcement").status).toBe("present");
    const sso = find(result.findings, "org_sso_enforcement");
    expect(sso.status).not.toBe("present");
    expect(sso.status).toBe("unknown");
    expect(sso.reason).toBe("not_observable_by_repo_token");
  });

  it("is not_applicable for a user-owned repository", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "User" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const sso = find(result.findings, "org_sso_enforcement");
    expect(sso.status).toBe("not_applicable");
    expect(sso.reason).toBe("not_applicable");
  });

  it("stays not_observable_by_repo_token even when the org endpoint 200s with no relevant field", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 200, body: { two_factor_requirement_enabled: false } },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });
    const sso = find(result.findings, "org_sso_enforcement");
    expect(sso.observable).toBe(false);
    expect(sso.status).toBe("unknown");
    expect(sso.reason).toBe("not_observable_by_repo_token");
  });
});

// ─── summary counts + rendering ──────────────────────────────────────────────

describe("runPostureScan — summary counts", () => {
  it("tallies observed / not-observable / present / absent correctly", async () => {
    const fs_ = makeFs({ "/ws/.github/CODEOWNERS": "* @acme/eng\n" });
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "Organization" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      { match: ORG_URL, status: 403 },
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: fs_, repository: "acme/widgets", token: "tok", fetchImpl });

    expect(result.observed_count + result.not_observable_count + result.not_applicable_count).toBe(
      result.findings.length,
    );
    expect(result.present_count).toBeGreaterThan(0); // codeowners present
    expect(result.absent_count).toBeGreaterThan(0); // dependabot_config, codeql_workflow absent
    expect(result.not_observable_count).toBeGreaterThan(0); // branch protection etc. all 403
    expect(result.not_applicable_count).toBe(0); // organization-owned repo — no not_applicable findings
  });

  // Regression test for the P2 miscount fix: a not_applicable finding (org
  // settings on a user-owned repo) must be counted in its OWN bucket, never
  // folded into not_observable_count.
  it("counts not_applicable findings separately from not_observable ones (user-owned repo)", async () => {
    const fetchImpl = fetchRouting([
      { match: REPO_URL, status: 200, body: { default_branch: "main", owner: { type: "User" } } },
      { match: PROTECTION_URL, status: 403 },
      { match: ALERTS_URL, status: 403 },
      // No org route needed — both org findings short-circuit on owner type.
    ]);
    const result = await runPostureScan({ workspace: "/ws", fileSystem: NO_FILES, repository: "acme/widgets", token: "tok", fetchImpl });

    // org_2fa_enforcement + org_sso_enforcement are both not_applicable for a user-owned repo.
    expect(result.not_applicable_count).toBe(2);
    const notApplicableIds = result.findings.filter((f) => f.status === "not_applicable").map((f) => f.id);
    expect(notApplicableIds.sort()).toEqual(["org_2fa_enforcement", "org_sso_enforcement"]);
    // Neither not_applicable finding may leak into the "not observable" bucket.
    for (const id of notApplicableIds) {
      expect(find(result.findings, id).status).not.toBe("unknown");
    }
    // The three buckets partition all findings with no double-counting.
    expect(result.observed_count + result.not_observable_count + result.not_applicable_count).toBe(
      result.findings.length,
    );
  });
});

describe("renderPostureStepSummary", () => {
  it("renders a markdown table naming every finding, its status, and its reason", () => {
    const findings: PostureFinding[] = [
      { id: "codeowners", label: "CODEOWNERS file", observable: true, status: "present", reason: "observed", detail: "Found." },
      { id: "branch_protection", label: "Branch protection (main)", observable: false, status: "unknown", reason: "insufficient_permission", detail: "Needs a differently-scoped credential." },
    ];
    const md = renderPostureStepSummary({
      findings,
      observed_count: 1,
      not_observable_count: 1,
      not_applicable_count: 0,
      present_count: 1,
      absent_count: 0,
    });
    expect(md).toMatch(/CODEOWNERS file/);
    expect(md).toMatch(/Branch protection \(main\)/);
    expect(md).toMatch(/insufficient_permission/);
    expect(md).toMatch(/1 of 2 signals observed/);
    expect(md).toMatch(/Advisory only/);
  });

  it("mentions the not_applicable count when non-zero", () => {
    const findings: PostureFinding[] = [
      { id: "org_2fa_enforcement", label: "Org-level 2FA enforcement", observable: false, status: "not_applicable", reason: "not_applicable", detail: "User account." },
    ];
    const md = renderPostureStepSummary({
      findings,
      observed_count: 0,
      not_observable_count: 0,
      not_applicable_count: 1,
      present_count: 0,
      absent_count: 0,
    });
    expect(md).toMatch(/1 not applicable/);
  });
});
