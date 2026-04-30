import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateInfraError, verifyOne } from "../gate";

// SIM tests for verifyOne() — the verify-permit helper used by the v2.1
// batch path (src/batch.ts). The single-eval path uses @atlasent/enforce
// which has its own verify-permit test suite (packages/enforce).

describe("verifyOne", () => {
  const fetchMock = vi.fn();

  const PARAMS = {
    apiUrl: "https://api.test",
    apiKey: "ask_test_key",
    actionType: "production_deploy",
    actorId: "github:alice",
    permitToken: "pt-abc",
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResp(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns { verified: true, outcome } on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ verified: true, outcome: "ok" }));
    const r = await verifyOne(PARAMS);
    expect(r.verified).toBe(true);
    expect(r.outcome).toBe("ok");
  });

  it("returns { verified: false } when server returns verified=false", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ verified: false, outcome: "permit_consumed" }));
    const r = await verifyOne(PARAMS);
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("permit_consumed");
  });

  // ── Request shape ───────────────────────────────────────────────────────────

  it("uses /v1-verify-permit by default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ verified: true }));
    await verifyOne(PARAMS);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/v1-verify-permit");
  });

  it("uses custom verifyPath when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ verified: true }));
    await verifyOne({ ...PARAMS, verifyPath: "/v1/verify-permit" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/v1/verify-permit");
  });

  it("sends permit_token, action_type, actor_id in the request body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ verified: true }));
    await verifyOne(PARAMS);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.permit_token).toBe("pt-abc");
    expect(body.action_type).toBe("production_deploy");
    expect(body.actor_id).toBe("github:alice");
  });

  it("sends Authorization header with the api key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ verified: true }));
    await verifyOne(PARAMS);
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ask_test_key");
  });

  // ── Infrastructure errors ───────────────────────────────────────────────────

  it("throws GateInfraError on transport error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    let caught: unknown;
    await verifyOne(PARAMS).catch((e) => { caught = e; });
    expect(caught).toBeInstanceOf(GateInfraError);
    expect((caught as GateInfraError).message).toMatch(/verify-permit unreachable/);
  });

  it("throws GateInfraError on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ error: "internal" }, 500));
    let caught: unknown;
    await verifyOne(PARAMS).catch((e) => { caught = e; });
    expect(caught).toBeInstanceOf(GateInfraError);
    expect((caught as GateInfraError).statusCode).toBe(500);
  });

  it("throws GateInfraError on non-JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(verifyOne(PARAMS)).rejects.toThrow(GateInfraError);
  });
});
