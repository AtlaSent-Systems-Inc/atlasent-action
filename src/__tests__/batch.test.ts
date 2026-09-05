import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateMany, bindTrustedStateSnapshot } from "../batch";

// Mock @atlasent/enforce so verifyPermit uses a test double rather than the
// real HTTP transport. fetch is still needed for the evaluate calls.
vi.mock("@atlasent/enforce", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlasent/enforce")>();
  return { ...actual, verifyPermit: vi.fn() };
});

import { verifyPermit } from "@atlasent/enforce";
const mockVerifyPermit = verifyPermit as ReturnType<typeof vi.fn>;

describe("evaluateMany", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    mockVerifyPermit.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function evalResp(decision = "allow", permitToken = "tok1") {
    return new Response(
      JSON.stringify({ decision, evaluatedAt: "2026-04-25T00:00:00Z", permitToken }),
    );
  }

  it("loops /v1-evaluate and verifies each allow decision", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/v1-evaluate")) {
        return Promise.resolve(evalResp("allow", "tok1"));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    const out = await evaluateMany("https://api.test", "k", [
      { action: "a", actor: "u" },
      { action: "b", actor: "u" },
    ]);

    expect(out.decisions).toHaveLength(2);
    expect(out.decisions[0].verified).toBe(true);
    expect(out.decisions[1].verified).toBe(true);
    expect(out.batchId).toMatch(/^loop-/);
    // Every item goes through the per-item /v1-evaluate endpoint — there is
    // no /v1-evaluate/batch route on the runtime API (#131).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://api.test/v1-evaluate");
    }
  });

  it("deny decisions are not verified (no verifyPermit call)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ decision: "deny", evaluatedAt: "2026-04-25T00:00:00Z" }))),
    );

    const out = await evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }]);

    // only the evaluate call — no verifyPermit call for deny
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockVerifyPermit).not.toHaveBeenCalled();
    expect(out.decisions[0].decision).toBe("deny");
    expect(out.decisions[0].verified).toBeUndefined();
  });

  it("allow with no permitToken → verified=false (no verifyPermit call)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ decision: "allow", evaluatedAt: "2026-04-25T00:00:00Z" })),
    );

    const out = await evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }]);

    expect(out.decisions[0].verified).toBe(false);
    expect(mockVerifyPermit).not.toHaveBeenCalled();
    // only the evaluate call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on non-2xx evaluate response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(
      evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }]),
    ).rejects.toThrow(/500/);
  });

  it("throws on verifyPermit failure (fail-closed)", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok1"));
    mockVerifyPermit.mockRejectedValueOnce(new Error("verify-permit infrastructure failure (HTTP 500)"));

    await expect(
      evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }]),
    ).rejects.toThrow(/verify-permit infrastructure failure/);
  });

  it("passes correct config and decision to verifyPermit", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok-xyz"));
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "ok" });

    await evaluateMany("https://api.test", "api-key-123", [
      { action: "production.deploy", actor: "alice" },
    ]);

    expect(mockVerifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "api-key-123",
        apiUrl: "https://api.test",
        action: "production.deploy",
        actor: "alice",
      }),
      expect.objectContaining({
        decision: "allow",
        permitToken: "tok-xyz",
      }),
    );
  });

  it("binds each item's OWN environment/target/digest at verify (cross-item isolation)", async () => {
    const items = [
      { action: "production.deploy", actor: "alice", environment: "production", target_id: "svc:api", execution_payload_hash: "sha256:A" },
      { action: "production.deploy", actor: "bob", environment: "staging", target_id: "svc:worker", execution_payload_hash: "sha256:B" },
    ];
    fetchMock
      .mockResolvedValueOnce(evalResp("allow", "tokA"))
      .mockResolvedValueOnce(evalResp("allow", "tokB"));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    await evaluateMany("https://api.test", "k", items);

    // Item 0's permit is verified under item 0's OWN bindings + requires them.
    expect(mockVerifyPermit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "production.deploy",
        actor: "alice",
        environment: "production",
        targetId: "svc:api",
        executionPayloadHash: "sha256:A",
        requiredBindings: ["environment", "target_id", "payload_hash"],
      }),
      expect.objectContaining({ permitToken: "tokA" }),
    );
    // Item 1 is verified under item 1's OWN bindings — NOT item 0's (no cross-item bleed).
    expect(mockVerifyPermit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "production.deploy",
        actor: "bob",
        environment: "staging",
        targetId: "svc:worker",
        executionPayloadHash: "sha256:B",
        requiredBindings: ["environment", "target_id", "payload_hash"],
      }),
      expect.objectContaining({ permitToken: "tokB" }),
    );
  });

  it("re-presents the runtime-derived hash for a structured production change plan", async () => {
    const item = {
      action: "production.deploy",
      actor: "workload:github:deploy",
      environment: "staging",
      change_plan: { operation: "deploy", revision: "abc123" },
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      decision: "allow",
      evaluatedAt: "2026-08-27T00:00:00Z",
      permitToken: "tok-plan",
      execution_hash_expected: "server-derived-plan-hash",
    })));
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "verified" });

    await evaluateMany("https://api.test", "k", [item]);

    expect(mockVerifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPayloadHash: "server-derived-plan-hash",
        requiredBindings: ["environment", "payload_hash"],
      }),
      expect.objectContaining({
        permitToken: "tok-plan",
        executionHashExpected: "server-derived-plan-hash",
      }),
    );
  });

  it("fails closed when an item's permit fails verification (substitution / mismatch)", async () => {
    const items = [
      { action: "production.deploy", actor: "alice", environment: "production", target_id: "svc:api", execution_payload_hash: "sha256:A" },
    ];
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tokA"));
    mockVerifyPermit.mockRejectedValueOnce(
      new Error("Permit verification failed (outcome=mismatch, code=PAYLOAD_MISMATCH)"),
    );
    await expect(
      evaluateMany("https://api.test", "k", items),
    ).rejects.toThrow(/PAYLOAD_MISMATCH/);
  });

  // ── Issue #148 — evaluateMany returns the BOUND items, not the raw ones ──
  it("returns the bound items on BatchResult (not the raw pre-bind items) for downstream evidence emission", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok1"));
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "ok" });

    const out = await evaluateMany("https://api.test", "k", [
      {
        action: "production.deploy",
        actor: "alice",
        context: { repository: "attacker-org/evil" },
      },
    ]);

    expect(out.items).toHaveLength(1);
    expect((out.items[0].context as Record<string, unknown>)["repository"]).not.toBe(
      "attacker-org/evil",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Issue #148 — batch production evaluations must require the same
// GitHub-derived state_snapshot the single-eval path already requires.
//
// A post-merge audit of #138 found the batch path posted `evaluations:`
// items to /v1-evaluate completely unmodified, so a caller could
// self-assert (or omit) `state_snapshot` / `context.repository` /
// `context.ref` / `context.sha` for a production.deploy batch item —
// silently bypassing the trusted-GitHub-state binding the single path
// enforces (src/index.ts's `config.state_snapshot` +
// `context: { ...extraContext, repository: gh.repository, ... }`).
//
// These tests cover both layers:
//   - bindTrustedStateSnapshot() directly (the pure transform), and
//   - evaluateMany() end-to-end, asserting the actual HTTP request body
//     sent to the server carries the trusted values — not whatever a
//     caller supplied.
// ─────────────────────────────────────────────────────────────────────────
describe("bindTrustedStateSnapshot (issue #148)", () => {
  const TRUSTED_ENV = {
    GITHUB_REPOSITORY: "AtlaSent-Systems-Inc/atlasent-action",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "cafef00dcafef00dcafef00dcafef00dcafef00d".slice(0, 40),
    GITHUB_WORKFLOW: "Deploy",
    GITHUB_RUN_ID: "999888777",
    GITHUB_RUN_NUMBER: "42",
    GITHUB_EVENT_NAME: "push",
  };

  beforeEach(() => {
    vi.stubEnv("GITHUB_REPOSITORY", TRUSTED_ENV.GITHUB_REPOSITORY);
    vi.stubEnv("GITHUB_REF", TRUSTED_ENV.GITHUB_REF);
    vi.stubEnv("GITHUB_SHA", TRUSTED_ENV.GITHUB_SHA);
    vi.stubEnv("GITHUB_WORKFLOW", TRUSTED_ENV.GITHUB_WORKFLOW);
    vi.stubEnv("GITHUB_RUN_ID", TRUSTED_ENV.GITHUB_RUN_ID);
    vi.stubEnv("GITHUB_RUN_NUMBER", TRUSTED_ENV.GITHUB_RUN_NUMBER);
    vi.stubEnv("GITHUB_EVENT_NAME", TRUSTED_ENV.GITHUB_EVENT_NAME);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Missing ────────────────────────────────────────────────────────────
  it("MISSING: a production.deploy item with no context/state_snapshot at all gets a real, trusted one attached", () => {
    const [bound] = bindTrustedStateSnapshot([
      { action: "production.deploy", actor: "alice" },
    ]);

    expect(bound.state_snapshot).toEqual({
      source: "github-actions",
      complete: true,
      run_id: TRUSTED_ENV.GITHUB_RUN_ID,
    });
    expect(bound.context).toMatchObject({
      repository: TRUSTED_ENV.GITHUB_REPOSITORY,
      ref: TRUSTED_ENV.GITHUB_REF,
      sha: TRUSTED_ENV.GITHUB_SHA,
    });
  });

  // ── Malformed ──────────────────────────────────────────────────────────
  it("MALFORMED: a caller-asserted top-level state_snapshot is discarded, never forwarded", () => {
    const [bound] = bindTrustedStateSnapshot([
      {
        action: "production.deploy",
        actor: "alice",
        // A caller-authored, self-reported snapshot — not a real GitHub Actions one.
        state_snapshot: { source: "self-reported", complete: false } as never,
      },
    ]);

    expect(bound.state_snapshot).toEqual({
      source: "github-actions",
      complete: true,
      run_id: TRUSTED_ENV.GITHUB_RUN_ID,
    });
  });

  it("MALFORMED: a caller-asserted state_snapshot nested inside context is discarded, never forwarded", () => {
    const [bound] = bindTrustedStateSnapshot([
      {
        action: "production.deploy",
        actor: "alice",
        context: {
          // Wrong shape (a bare string) nested where the wire actually
          // expects state_snapshot to live at the top level — must not
          // survive into the outgoing context OR be treated as evidence.
          state_snapshot: "not-a-real-snapshot",
        },
      },
    ]);

    expect((bound.context as Record<string, unknown>)["state_snapshot"]).toBeUndefined();
    expect(bound.state_snapshot).toEqual({
      source: "github-actions",
      complete: true,
      run_id: TRUSTED_ENV.GITHUB_RUN_ID,
    });
  });

  // ── Wrong repository ──────────────────────────────────────────────────
  it("WRONG-REPOSITORY: a caller-asserted context.repository is overridden with the trusted repository", () => {
    const [bound] = bindTrustedStateSnapshot([
      {
        action: "production.deploy",
        actor: "alice",
        context: { repository: "attacker-org/definitely-not-this-repo" },
      },
    ]);

    expect((bound.context as Record<string, unknown>)["repository"]).toBe(
      TRUSTED_ENV.GITHUB_REPOSITORY,
    );
  });

  // ── Wrong ref ─────────────────────────────────────────────────────────
  it("WRONG-REF: a caller-asserted context.ref (and sha) is overridden with the trusted ref/sha", () => {
    const [bound] = bindTrustedStateSnapshot([
      {
        action: "production.deploy",
        actor: "alice",
        context: {
          ref: "refs/heads/malicious-unreviewed-branch",
          sha: "0000000000000000000000000000000000000000",
        },
      },
    ]);

    expect((bound.context as Record<string, unknown>)["ref"]).toBe(TRUSTED_ENV.GITHUB_REF);
    expect((bound.context as Record<string, unknown>)["sha"]).toBe(TRUSTED_ENV.GITHUB_SHA);
  });

  // ── Scope + preservation checks ──────────────────────────────────────
  it("does not touch non-production.deploy items at all", () => {
    const item = {
      action: "package.release",
      actor: "release-bot",
      context: { repository: "whatever/i-want", ref: "refs/heads/anything" },
    };
    const [bound] = bindTrustedStateSnapshot([item]);
    expect(bound).toEqual(item);
    expect(bound.state_snapshot).toBeUndefined();
  });

  it("only overrides the trusted keys — other caller-supplied context survives untouched", () => {
    const [bound] = bindTrustedStateSnapshot([
      {
        action: "production.deploy",
        actor: "alice",
        context: { financial_action_value: 500, custom_note: "keep me" },
      },
    ]);
    expect((bound.context as Record<string, unknown>)["financial_action_value"]).toBe(500);
    expect((bound.context as Record<string, unknown>)["custom_note"]).toBe("keep me");
    expect((bound.context as Record<string, unknown>)["repository"]).toBe(
      TRUSTED_ENV.GITHUB_REPOSITORY,
    );
  });

  it("in a mixed batch, only the production.deploy item is bound", () => {
    const bound = bindTrustedStateSnapshot([
      { action: "package.release", actor: "bot", context: { repository: "forged/repo" } },
      { action: "production.deploy", actor: "alice" },
    ]);
    expect((bound[0].context as Record<string, unknown>)["repository"]).toBe("forged/repo");
    expect(bound[0].state_snapshot).toBeUndefined();
    expect((bound[1].context as Record<string, unknown>)["repository"]).toBe(
      TRUSTED_ENV.GITHUB_REPOSITORY,
    );
    expect(bound[1].state_snapshot).toEqual({
      source: "github-actions",
      complete: true,
      run_id: TRUSTED_ENV.GITHUB_RUN_ID,
    });
  });
});

describe("evaluateMany sends the trusted state_snapshot on the wire (issue #148)", () => {
  const fetchMock = vi.fn();
  const TRUSTED_ENV = {
    GITHUB_REPOSITORY: "AtlaSent-Systems-Inc/atlasent-action",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "1111111111111111111111111111111111111111",
    GITHUB_RUN_ID: "555",
  };

  beforeEach(() => {
    fetchMock.mockReset();
    mockVerifyPermit.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_REPOSITORY", TRUSTED_ENV.GITHUB_REPOSITORY);
    vi.stubEnv("GITHUB_REF", TRUSTED_ENV.GITHUB_REF);
    vi.stubEnv("GITHUB_SHA", TRUSTED_ENV.GITHUB_SHA);
    vi.stubEnv("GITHUB_RUN_ID", TRUSTED_ENV.GITHUB_RUN_ID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function evalResp(decision = "allow", permitToken = "tok1") {
    return new Response(
      JSON.stringify({ decision, evaluatedAt: "2026-04-25T00:00:00Z", permitToken }),
    );
  }

  it("the request body sent to /v1-evaluate carries the trusted snapshot/context, not the caller's forged values", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok1"));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    await evaluateMany("https://api.test", "k", [
      {
        action: "production.deploy",
        actor: "alice",
        context: {
          repository: "attacker-org/evil",
          ref: "refs/heads/evil",
          state_snapshot: "forged",
        },
        state_snapshot: { source: "self-reported", complete: true } as never,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.state_snapshot).toEqual({
      source: "github-actions",
      complete: true,
      run_id: TRUSTED_ENV.GITHUB_RUN_ID,
    });
    expect(sentBody.context.repository).toBe(TRUSTED_ENV.GITHUB_REPOSITORY);
    expect(sentBody.context.ref).toBe(TRUSTED_ENV.GITHUB_REF);
    expect(sentBody.context.state_snapshot).toBeUndefined();
  });

  it("every item in a multi-item loop batch carries the trusted snapshot/context", async () => {
    fetchMock
      .mockResolvedValueOnce(evalResp("allow", "tokA"))
      .mockResolvedValueOnce(evalResp("allow", "tokB"));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    await evaluateMany("https://api.test", "k", [
      {
        action: "production.deploy",
        actor: "alice",
        context: { repository: "attacker-org/evil" },
      },
      { action: "production.deploy", actor: "bob", context: { ref: "refs/heads/evil" } },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const sentItem = JSON.parse((call[1] as RequestInit).body as string);
      expect(sentItem.state_snapshot).toEqual({
        source: "github-actions",
        complete: true,
        run_id: TRUSTED_ENV.GITHUB_RUN_ID,
      });
      expect(sentItem.context.repository).toBe(TRUSTED_ENV.GITHUB_REPOSITORY);
      expect(sentItem.context.ref).toBe(TRUSTED_ENV.GITHUB_REF);
    }
  });
});
