import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPolicySync, formatSyncDiff } from "../policySync";
import type { PolicySyncRun, PolicySyncOptions } from "../policySync";

// ---------------------------------------------------------------------------
// fs mock — must be declared before any import that touches node:fs
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUNDLE = [
  { name: "policy-a", body: "allow if true" },
  { name: "policy-b", body: "deny if false", description: "test", tags: ["t1"] },
];

function makeRun(overrides: Partial<PolicySyncRun> = {}): PolicySyncRun {
  return {
    id: "psync_01abc",
    org_id: "org_01xyz",
    source: "github-action",
    bundle_hash: "sha256:deadbeef",
    status: "completed",
    policies_added: 0,
    policies_updated: 0,
    policies_removed: 0,
    ...overrides,
  };
}

function stubFetch(run: PolicySyncRun, httpStatus = 200) {
  return vi.fn().mockResolvedValue({
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: vi.fn().mockResolvedValue(run),
    text: vi.fn().mockResolvedValue(""),
  });
}

const BASE: PolicySyncOptions = {
  apiKey: "ask_test_key",
  apiUrl: "https://api.atlasent.io",
  bundlePath: "policies/bundle.json",
  dryRun: true,
};

// ---------------------------------------------------------------------------
// formatSyncDiff
// ---------------------------------------------------------------------------

describe("formatSyncDiff", () => {
  it('returns "no changes" when all counts are zero', () => {
    expect(formatSyncDiff(makeRun())).toBe("no changes");
  });

  it("formats added-only", () => {
    expect(formatSyncDiff(makeRun({ policies_added: 3 }))).toBe("+3 added");
  });

  it("formats updated-only", () => {
    expect(formatSyncDiff(makeRun({ policies_updated: 2 }))).toBe("~2 updated");
  });

  it("formats removed-only", () => {
    expect(formatSyncDiff(makeRun({ policies_removed: 1 }))).toBe("-1 removed");
  });

  it("formats added + updated + removed", () => {
    expect(
      formatSyncDiff(makeRun({ policies_added: 1, policies_updated: 2, policies_removed: 3 })),
    ).toBe("+1 added, ~2 updated, -3 removed");
  });

  it("formats added + updated (no removed)", () => {
    expect(
      formatSyncDiff(makeRun({ policies_added: 2, policies_updated: 1 })),
    ).toBe("+2 added, ~1 updated");
  });

  it("formats updated + removed (no added)", () => {
    expect(
      formatSyncDiff(makeRun({ policies_updated: 1, policies_removed: 4 })),
    ).toBe("~1 updated, -4 removed");
  });
});

// ---------------------------------------------------------------------------
// runPolicySync
// ---------------------------------------------------------------------------

describe("runPolicySync", () => {
  beforeEach(() => {
    process.env["GITHUB_WORKSPACE"] = "/workspace";
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    delete process.env["GITHUB_WORKSPACE"];
  });

  // ── File-system errors ────────────────────────────────────────────────

  it("throws when bundle file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(runPolicySync(BASE)).rejects.toThrow(/Policy bundle not found/);
  });

  it("includes the resolved path in the not-found error message", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env["GITHUB_WORKSPACE"] = "/custom/ws";
    await expect(runPolicySync(BASE)).rejects.toThrow(
      /\/custom\/ws\/policies\/bundle\.json/,
    );
  });

  it("throws when bundle is not valid JSON", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not-json" as unknown as Buffer);
    await expect(runPolicySync(BASE)).rejects.toThrow(/Failed to parse policy bundle/);
  });

  it("throws when bundle JSON is not an array", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ name: "x" }) as unknown as Buffer,
    );
    await expect(runPolicySync(BASE)).rejects.toThrow(/must be a JSON array/);
  });

  it("throws when bundle array is empty", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([]) as unknown as Buffer);
    await expect(runPolicySync(BASE)).rejects.toThrow(/empty/);
  });

  // ── Network / HTTP errors ───────────────────────────────────────────

  it("throws on network error (fetch rejects)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(runPolicySync(BASE)).rejects.toThrow(/Network error/);
  });

  it("throws on non-OK response with error detail in body", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: vi.fn().mockResolvedValue({ error: "invalid policy syntax" }),
      }),
    );
    await expect(runPolicySync(BASE)).rejects.toThrow(/422.*invalid policy syntax/);
  });

  it("throws on non-OK response when error body is unparseable", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn().mockRejectedValue(new Error("not json")),
      }),
    );
    await expect(runPolicySync(BASE)).rejects.toThrow(/500/);
  });

  it("throws when success response body is not valid JSON", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new Error("unexpected token")),
      }),
    );
    await expect(runPolicySync(BASE)).rejects.toThrow(/parse JSON response/);
  });

  // ── Happy paths ───────────────────────────────────────────────────

  it("returns run, formatted diff, and rejected=false on completed", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const run = makeRun({ policies_added: 2, policies_updated: 1 });
    vi.stubGlobal("fetch", stubFetch(run));

    const result = await runPolicySync(BASE);
    expect(result.run).toEqual(run);
    expect(result.diff).toBe("+2 added, ~1 updated");
    expect(result.rejected).toBe(false);
  });

  it('sets rejected=true when status is "rejected"', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    vi.stubGlobal("fetch", stubFetch(makeRun({ status: "rejected" })));
    const result = await runPolicySync(BASE);
    expect(result.rejected).toBe(true);
  });

  it('sets rejected=true when status is "failed"', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    vi.stubGlobal("fetch", stubFetch(makeRun({ status: "failed" })));
    const result = await runPolicySync(BASE);
    expect(result.rejected).toBe(true);
  });

  it('sets rejected=false when status is "validating" (still in progress)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    vi.stubGlobal("fetch", stubFetch(makeRun({ status: "validating" })));
    const result = await runPolicySync(BASE);
    expect(result.rejected).toBe(false);
  });

  // ── Request construction ────────────────────────────────────────────

  it("hits the correct URL, stripping trailing slash from apiUrl", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const fetchMock = stubFetch(makeRun());
    vi.stubGlobal("fetch", fetchMock);

    await runPolicySync({ ...BASE, apiUrl: "https://api.example.com/" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/v1/policy-sync");
  });

  it("sends Bearer Authorization header", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const fetchMock = stubFetch(makeRun());
    vi.stubGlobal("fetch", fetchMock);

    await runPolicySync(BASE);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer ask_test_key",
    );
  });

  it("sends dry_run=true in request body", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const fetchMock = stubFetch(makeRun());
    vi.stubGlobal("fetch", fetchMock);

    await runPolicySync({ ...BASE, dryRun: true });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.dry_run).toBe(true);
  });

  it("sends dry_run=false in request body", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const fetchMock = stubFetch(makeRun());
    vi.stubGlobal("fetch", fetchMock);

    await runPolicySync({ ...BASE, dryRun: false });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.dry_run).toBe(false);
  });

  it("sends source, commit_sha, and ref in request body", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const fetchMock = stubFetch(makeRun());
    vi.stubGlobal("fetch", fetchMock);

    await runPolicySync({
      ...BASE,
      source: "ci-pipeline",
      commitSha: "abc1234",
      ref: "refs/heads/main",
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.source).toBe("ci-pipeline");
    expect(body.commit_sha).toBe("abc1234");
    expect(body.ref).toBe("refs/heads/main");
  });

  it("defaults source to 'github-action' when not provided", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const fetchMock = stubFetch(makeRun());
    vi.stubGlobal("fetch", fetchMock);

    await runPolicySync(BASE); // no source provided
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.source).toBe("github-action");
  });

  it("sends the full policy array from the bundle file", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(BUNDLE) as unknown as Buffer,
    );
    const fetchMock = stubFetch(makeRun());
    vi.stubGlobal("fetch", fetchMock);

    await runPolicySync(BASE);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.policies).toHaveLength(2);
    expect(body.policies[0].name).toBe("policy-a");
  });

  it("uses GITHUB_WORKSPACE to resolve relative bundle path", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env["GITHUB_WORKSPACE"] = "/repo";
    await expect(runPolicySync(BASE)).rejects.toThrow(/\/repo\/policies\/bundle\.json/);
  });

  it("accepts an absolute bundle path without prepending GITHUB_WORKSPACE", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(
      runPolicySync({ ...BASE, bundlePath: "/absolute/path/bundle.json" }),
    ).rejects.toThrow(/\/absolute\/path\/bundle\.json/);
    // should NOT have "/workspace" prepended
    const [call] = vi.mocked(fs.existsSync).mock.calls;
    expect(call[0]).toBe("/absolute/path/bundle.json");
  });
});
