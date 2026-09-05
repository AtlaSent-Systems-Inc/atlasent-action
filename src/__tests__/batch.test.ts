import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateMany } from "../batch";

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
});
