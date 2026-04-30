import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateInfraError, runGate } from "../gate";

// SIM tests — simulate all decision-matrix paths without real HTTP.
// Decision matrix (mirrors atlasent-sdk withPermit / with_permit contract):
//
//  evaluate result          verify result          gate outcome
//  ─────────────────────────────────────────────────────────────
//  transport error          —                      GateInfraError
//  5xx / 401 / 403 / 429   —                      GateInfraError
//  decision=deny/hold/esc   —                      ok=false, verified=false
//  allow, no permit_token   —                      GateInfraError
//  allow                    transport error        GateInfraError
//  allow                    !2xx                   GateInfraError
//  allow                    verified=false         ok=false, verified=false
//  allow                    verified=true          ok=true,  verified=true

describe("runGate SIM tests", () => {
  const fetchMock = vi.fn();

  const PARAMS = {
    apiUrl: "https://api.test",
    apiKey: "ask_test_key",
    actionType: "production_deploy",
    actorId: "github:alice",
    payload: { action_type: "production_deploy", actor_id: "github:alice", context: {} },
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

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("allow + verify=true → ok=true, verified=true", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResp({ decision: "allow", permit_token: "tok1", evaluation_id: "ev1", proof_hash: "ph1" }),
      )
      .mockResolvedValueOnce(jsonResp({ verified: true, outcome: "ok" }));

    const r = await runGate(PARAMS);

    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.decision).toBe("allow");
    expect(r.permitToken).toBe("tok1");
    expect(r.evaluationId).toBe("ev1");
    if (r.ok) expect(r.verifyOutcome).toBe("ok");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.test/v1-evaluate",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.test/v1-verify-permit",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("verify call sends permit_token + action_type + actor_id", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ decision: "allow", permit_token: "tok42" }))
      .mockResolvedValueOnce(jsonResp({ verified: true }));

    await runGate(PARAMS);

    const verifyCall = fetchMock.mock.calls[1];
    const body = JSON.parse(verifyCall[1].body as string) as Record<string, unknown>;
    expect(body.permit_token).toBe("tok42");
    expect(body.action_type).toBe("production_deploy");
    expect(body.actor_id).toBe("github:alice");
  });

  it("propagates risk_score (flat shape) from evaluate", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ decision: "allow", permit_token: "t", risk_score: 0.85 }))
      .mockResolvedValueOnce(jsonResp({ verified: true }));

    const r = await runGate(PARAMS);
    expect(r.riskScore).toBe("0.85");
  });

  it("propagates risk.score (canonical shape) from evaluate", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResp({ decision: "allow", permit_token: "t", risk: { level: "high", score: 0.9 } }),
      )
      .mockResolvedValueOnce(jsonResp({ verified: true }));

    const r = await runGate(PARAMS);
    expect(r.riskScore).toBe("0.9");
  });

  // ── Replay / expired permit ─────────────────────────────────────────────────

  it("allow + verify.verified=false (replay) → ok=false, verified=false", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ decision: "allow", permit_token: "tok1" }))
      .mockResolvedValueOnce(jsonResp({ verified: false, outcome: "permit_consumed" }));

    const r = await runGate(PARAMS);

    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.decision).toBe("allow");
    if (!r.ok) {
      expect(r.verifyOutcome).toBe("permit_consumed");
      expect(r.reason).toMatch(/permit verification failed/);
    }
  });

  it("allow + verify.verified=false (expired) → ok=false, verified=false", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ decision: "allow", permit_token: "tok1" }))
      .mockResolvedValueOnce(jsonResp({ verified: false, outcome: "permit_expired" }));

    const r = await runGate(PARAMS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.verifyOutcome).toBe("permit_expired");
  });

  // ── No permit_token on allow ────────────────────────────────────────────────

  it("allow + no permit_token → throws GateInfraError, no verify call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ decision: "allow", evaluation_id: "ev1" }));

    let caught: unknown;
    await runGate(PARAMS).catch((e) => { caught = e; });
    expect(caught).toBeInstanceOf(GateInfraError);
    expect((caught as GateInfraError).message).toMatch(/no permit_token/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Policy decisions (deny / hold / escalate) ───────────────────────────────

  it("deny → ok=false, verified=false, reason=deny_reason, no verify call", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResp({ decision: "deny", deny_reason: "outside change window" }),
    );

    const r = await runGate(PARAMS);
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.decision).toBe("deny");
    if (!r.ok) expect(r.reason).toBe("outside change window");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hold → ok=false, verified=false, no verify call", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResp({ decision: "hold", hold_reason: "awaiting approval" }),
    );

    const r = await runGate(PARAMS);
    expect(r.ok).toBe(false);
    expect(r.decision).toBe("hold");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("escalate → ok=false, verified=false, no verify call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ decision: "escalate" }));

    const r = await runGate(PARAMS);
    expect(r.ok).toBe(false);
    expect(r.decision).toBe("escalate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Infrastructure errors (evaluate side) ──────────────────────────────────

  it("evaluate transport error → throws GateInfraError", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    let caught: unknown;
    await runGate(PARAMS).catch((e) => { caught = e; });
    expect(caught).toBeInstanceOf(GateInfraError);
    expect((caught as GateInfraError).message).toMatch(/evaluate unreachable/);
  });

  it("evaluate 5xx → throws GateInfraError (fail-closed)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ error: "internal" }, 500));

    await expect(runGate(PARAMS)).rejects.toThrow(GateInfraError);
  });

  it("evaluate 401 → throws GateInfraError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ error: "unauthorized" }, 401));

    await expect(runGate(PARAMS)).rejects.toThrow(GateInfraError);
  });

  it("evaluate 403 → throws GateInfraError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ error: "forbidden" }, 403));

    await expect(runGate(PARAMS)).rejects.toThrow(GateInfraError);
  });

  it("evaluate 429 → throws GateInfraError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ error: "rate limited" }, 429));

    await expect(runGate(PARAMS)).rejects.toThrow(GateInfraError);
  });

  // ── Infrastructure errors (verify side) ────────────────────────────────────

  it("allow + verify transport error → throws GateInfraError", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ decision: "allow", permit_token: "tok1" }))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"));

    let caught: unknown;
    await runGate(PARAMS).catch((e) => { caught = e; });
    expect(caught).toBeInstanceOf(GateInfraError);
    expect((caught as GateInfraError).message).toMatch(/verify-permit unreachable/);
  });

  it("allow + verify 5xx → throws GateInfraError", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ decision: "allow", permit_token: "tok1" }))
      .mockResolvedValueOnce(jsonResp({ error: "internal" }, 500));

    await expect(runGate(PARAMS)).rejects.toThrow(GateInfraError);
  });

  it("allow + verify 4xx → throws GateInfraError", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ decision: "allow", permit_token: "tok1" }))
      .mockResolvedValueOnce(jsonResp({ error: "bad request" }, 400));

    await expect(runGate(PARAMS)).rejects.toThrow(GateInfraError);
  });
});
