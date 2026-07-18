import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateMany, BATCH_MAX_ITEMS, BATCH_MIN_ITEMS } from "../batch";

// Mock @atlasent/enforce so verifyPermit uses a test double rather than the
// real HTTP transport. fetch is still needed for the evaluate calls.
vi.mock("@atlasent/enforce", () => ({ verifyPermit: vi.fn() }));

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

  function batchResp(count: number, batchId = "b1", permitTokenPrefix = "tok") {
    const results = Array.from({ length: count }, (_, i) => ({
      decision: "allow",
      evaluatedAt: "2026-04-25T00:00:00Z",
      permitToken: `${permitTokenPrefix}${i}`,
    }));
    return new Response(JSON.stringify({ results, batchId }));
  }

  it("hits /v1-evaluate/batch when v2Batch=true and verifies allow decisions", async () => {
    // Two items so the batch path is actually taken (single-item batches
    // short-circuit to the loop now).
    fetchMock.mockResolvedValueOnce(batchResp(2, "b1"));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [
        { action: "a", actor: "u" },
        { action: "b", actor: "u" },
      ],
      true,
    );

    expect(out.batchId).toBe("b1");
    expect(out.decisions[0].verified).toBe(true);
    expect(out.decisions[1].verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1-evaluate/batch",
      expect.anything(),
    );
    expect(mockVerifyPermit).toHaveBeenCalledTimes(2);
  });

  it("loops /v1-evaluate when v2Batch=false and verifies each allow decision", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/v1-evaluate")) {
        return Promise.resolve(evalResp("allow", "tok1"));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [
        { action: "a", actor: "u" },
        { action: "b", actor: "u" },
      ],
      false,
    );

    expect(out.decisions).toHaveLength(2);
    expect(out.decisions[0].verified).toBe(true);
    expect(out.decisions[1].verified).toBe(true);
    expect(out.batchId).toMatch(/^loop-/);
  });

  it("deny decisions are not verified (no verifyPermit call)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ decision: "deny", evaluatedAt: "2026-04-25T00:00:00Z" }))),
    );

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [{ action: "a", actor: "u" }],
      false,
    );

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

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [{ action: "a", actor: "u" }],
      false,
    );

    expect(out.decisions[0].verified).toBe(false);
    expect(mockVerifyPermit).not.toHaveBeenCalled();
    // only the evaluate call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on non-2xx batch response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(
      evaluateMany(
        "https://api.test",
        "k",
        [
          { action: "a", actor: "u" },
          { action: "b", actor: "u" },
        ],
        true,
      ),
    ).rejects.toThrow(/500/);
  });

  it("throws on verifyPermit failure (fail-closed)", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok1"));
    mockVerifyPermit.mockRejectedValueOnce(new Error("verify-permit infrastructure failure (HTTP 500)"));

    await expect(
      evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }], false),
    ).rejects.toThrow(/verify-permit infrastructure failure/);
  });

  it("passes correct config and decision to verifyPermit", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok-xyz"));
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "ok" });

    await evaluateMany(
      "https://api.test",
      "api-key-123",
      [{ action: "production.deploy", actor: "alice" }],
      false,
    );

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

  it("a non-valid verify (e.g. mismatch) yields verified=false — item is not executable", async () => {
    // The runtime rejects a substituted artifact/env with a mismatch outcome;
    // the batch must surface verified=false (the workflow gates on it) rather
    // than reporting the allow as executable.
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok-mm"));
    mockVerifyPermit.mockResolvedValueOnce({ verified: false, outcome: "mismatch" });

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [{ action: "a", actor: "u", context: { execution_payload_hash: "sha256:evaluated" } }],
      false,
    );
    expect(out.decisions[0].verified).toBe(false);
    expect(out.decisions[0].verifyOutcome).toBe("mismatch");
  });

  it("re-binds each item's environment/target/payload_hash at verify (substitution resistance)", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok-bind"));
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "ok" });

    await evaluateMany(
      "https://api.test",
      "k",
      [
        {
          action: "production.deploy",
          actor: "alice",
          environment: "production",
          context: { target_id: "api-service", execution_payload_hash: "sha256:artifact-A" },
        },
      ],
      false,
    );

    expect(mockVerifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "production",
        targetId: "api-service",
        executionPayloadHash: "sha256:artifact-A",
      }),
      expect.objectContaining({ permitToken: "tok-bind" }),
    );
  });

  it("verifies each permit against its OWN item's bindings (no cross-item bleed)", async () => {
    // Two items, distinct artifacts/targets. Each permit must be verified with
    // the bindings of the SAME item — a permit for item 0 must never carry
    // item 1's payload hash.
    fetchMock.mockResolvedValueOnce(batchResp(2, "b1", "tok"));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    await evaluateMany(
      "https://api.test",
      "k",
      [
        { action: "a", actor: "u", environment: "staging", context: { target_id: "svc-0", execution_payload_hash: "sha256:zero" } },
        { action: "b", actor: "u", environment: "production", context: { target_id: "svc-1", execution_payload_hash: "sha256:one" } },
      ],
      true,
    );

    expect(mockVerifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "svc-0", executionPayloadHash: "sha256:zero", environment: "staging" }),
      expect.objectContaining({ permitToken: "tok0" }),
    );
    expect(mockVerifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "svc-1", executionPayloadHash: "sha256:one", environment: "production" }),
      expect.objectContaining({ permitToken: "tok1" }),
    );
  });

  // ── Wave B hardening: items<2 short-circuit ────────────────────────────────

  it("short-circuits to /v1-evaluate loop when v2Batch=true but only 1 item (no batch benefit)", async () => {
    // Even with v2Batch=true the single-item case should skip the batch
    // endpoint entirely — the round-trip cost isn't justified for one item.
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/v1-evaluate")) {
        return Promise.resolve(evalResp("allow", "tok-solo"));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "ok" });

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [{ action: "production.deploy", actor: "u" }],
      true, // v2Batch=true
    );

    // batch endpoint was NOT hit
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://api.test/v1-evaluate/batch",
      expect.anything(),
    );
    expect(out.batchId).toMatch(/^loop-/);
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0].verified).toBe(true);
  });

  it("BATCH_MIN_ITEMS is 2 (documented contract)", () => {
    expect(BATCH_MIN_ITEMS).toBe(2);
  });

  // ── Wave B hardening: 404 fallback ─────────────────────────────────────────

  it("falls back to per-item loop on 404 from /v1-evaluate/batch (v2_batch flag off)", async () => {
    // First call: batch 404 (tenant flag off)
    // Subsequent calls: per-item /v1-evaluate loop
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/v1-evaluate/batch")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (url.endsWith("/v1-evaluate")) {
        return Promise.resolve(evalResp("allow", "tok-fallback"));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [
        { action: "a", actor: "u" },
        { action: "b", actor: "u" },
      ],
      true,
    );

    // 1 batch attempt + 2 per-item evaluate calls = 3 fetches total
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/v1-evaluate/batch");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.test/v1-evaluate");
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.test/v1-evaluate");

    // After fallback, batchId is the loop marker (NOT a server batchId).
    expect(out.batchId).toMatch(/^loop-/);
    expect(out.decisions).toHaveLength(2);
    expect(out.decisions.every((d) => d.verified === true)).toBe(true);
  });

  it("does NOT fall back on non-404 batch errors (e.g. 500 is a real failure)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));

    await expect(
      evaluateMany(
        "https://api.test",
        "k",
        [
          { action: "a", actor: "u" },
          { action: "b", actor: "u" },
        ],
        true,
      ),
    ).rejects.toThrow(/500/);

    // 5xx fail-closed — must not silently fall back to the loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Wave B hardening: chunking when items > BATCH_MAX_ITEMS ────────────────

  it("BATCH_MAX_ITEMS is 100 (V2-D3 server hard-cap)", () => {
    expect(BATCH_MAX_ITEMS).toBe(100);
  });

  it("chunks into ≤100-item batches when items > BATCH_MAX_ITEMS", async () => {
    // 150 items → 2 chunks (100 + 50)
    const items = Array.from({ length: 150 }, (_, i) => ({
      action: "production.deploy",
      actor: `actor-${i}`,
    }));

    fetchMock
      .mockResolvedValueOnce(batchResp(100, "chunk-a"))
      .mockResolvedValueOnce(batchResp(50, "chunk-b"));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    const out = await evaluateMany("https://api.test", "k", items, true);

    // Two batch calls, no per-item loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/v1-evaluate/batch");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.test/v1-evaluate/batch");

    // First chunk has 100 items, second has 50 (sliced in input order).
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.items).toHaveLength(100);
    expect(secondBody.items).toHaveLength(50);
    expect(firstBody.items[0].actor).toBe("actor-0");
    expect(firstBody.items[99].actor).toBe("actor-99");
    expect(secondBody.items[0].actor).toBe("actor-100");
    expect(secondBody.items[49].actor).toBe("actor-149");

    // All 150 decisions are present in input order.
    expect(out.decisions).toHaveLength(150);
    // Multi-chunk: batchId is a synthetic `chunked-*` marker so
    // downstream audit refs aren't misleadingly pinned to chunk 0.
    expect(out.batchId).toMatch(/^chunked-/);
  });

  it("single chunk (≤BATCH_MAX_ITEMS) returns the server batchId verbatim", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      action: "production.deploy",
      actor: `actor-${i}`,
    }));
    fetchMock.mockResolvedValueOnce(batchResp(100, "server-batch-99"));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    const out = await evaluateMany("https://api.test", "k", items, true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.batchId).toBe("server-batch-99");
  });

  it("chunked path falls back to per-item loop if FIRST chunk 404s (no partial state)", async () => {
    // 120 items, but the very first batch call returns 404. We must NOT
    // half-commit (i.e. ship chunk 0 to /v1-evaluate/batch and then fall
    // back to the loop for the remaining 20 — that would mix transports
    // mid-batch). Falling back means looping ALL 120.
    const items = Array.from({ length: 120 }, (_, i) => ({
      action: "production.deploy",
      actor: `actor-${i}`,
    }));

    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/v1-evaluate/batch")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (url.endsWith("/v1-evaluate")) {
        return Promise.resolve(evalResp("allow", "tok-loop"));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "ok" });

    const out = await evaluateMany("https://api.test", "k", items, true);

    // 1 batch attempt + 120 per-item evaluate calls = 121 fetches
    expect(fetchMock).toHaveBeenCalledTimes(121);
    expect(out.decisions).toHaveLength(120);
    expect(out.batchId).toMatch(/^loop-/);
  });
});
