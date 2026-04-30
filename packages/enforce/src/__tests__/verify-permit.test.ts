import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPermit, EnforceError } from "../index";
import type { Decision } from "../index";

vi.mock("../transport", () => ({ post: vi.fn() }));

import { post } from "../transport";
const mockPost = post as ReturnType<typeof vi.fn>;

const BASE_CONFIG = {
  apiKey: "ask_test_key",
  apiUrl: "https://api.test",
  action: "production_deploy",
  actor: "alice",
};

const ALLOW_DECISION: Decision = {
  decision: "allow",
  evaluationId: "ev-1",
  permitToken: "pt-abc",
};

function mockResponse(status: number, body: unknown) {
  mockPost.mockResolvedValueOnce({ status, body: JSON.stringify(body) });
}

describe("verifyPermit", () => {
  beforeEach(() => mockPost.mockReset());
  afterEach(() => vi.restoreAllMocks());

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns { verified: true, outcome } on success", async () => {
    mockResponse(200, { verified: true, outcome: "ok" });
    const r = await verifyPermit(BASE_CONFIG, ALLOW_DECISION);
    expect(r.verified).toBe(true);
    expect(r.outcome).toBe("ok");
  });

  it("hits the correct verify-permit endpoint", async () => {
    mockResponse(200, { verified: true });
    await verifyPermit(BASE_CONFIG, ALLOW_DECISION);
    expect(mockPost.mock.calls[0][0]).toBe("https://api.test/v1/verify-permit");
  });

  it("sends permit_token + action_type + actor_id in body", async () => {
    mockResponse(200, { verified: true });
    await verifyPermit(BASE_CONFIG, ALLOW_DECISION);
    const body = JSON.parse(mockPost.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(body.permit_token).toBe("pt-abc");
    expect(body.action_type).toBe("production_deploy");
    expect(body.actor_id).toBe("alice");
  });

  it("sends Authorization header", async () => {
    mockResponse(200, { verified: true });
    await verifyPermit(BASE_CONFIG, ALLOW_DECISION);
    expect((mockPost.mock.calls[0][2] as Record<string, string>)["Authorization"]).toBe(
      "Bearer ask_test_key",
    );
  });

  it("strips trailing slash from apiUrl", async () => {
    mockResponse(200, { verified: true });
    await verifyPermit({ ...BASE_CONFIG, apiUrl: "https://api.test/" }, ALLOW_DECISION);
    expect(mockPost.mock.calls[0][0]).toBe("https://api.test/v1/verify-permit");
  });

  // ── No permit_token ─────────────────────────────────────────────────────────

  it("throws EnforceError(verify-permit) when decision has no permitToken", async () => {
    const noToken: Decision = { decision: "allow", evaluationId: "ev-1" };
    await expect(verifyPermit(BASE_CONFIG, noToken)).rejects.toSatisfy(
      (e: EnforceError) =>
        e instanceof EnforceError &&
        e.phase === "verify-permit" &&
        /no permit_token/.test(e.message),
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  // ── Replay / expired permit ──────────────────────────────────────────────────

  it("throws EnforceError(verify-permit) when verified=false (replay)", async () => {
    mockResponse(200, { verified: false, outcome: "permit_consumed" });
    await expect(verifyPermit(BASE_CONFIG, ALLOW_DECISION)).rejects.toSatisfy(
      (e: EnforceError) =>
        e instanceof EnforceError &&
        e.phase === "verify-permit" &&
        e.message.includes("permit_consumed"),
    );
  });

  it("throws EnforceError(verify-permit) when verified=false (expired)", async () => {
    mockResponse(200, { verified: false, outcome: "permit_expired" });
    await expect(verifyPermit(BASE_CONFIG, ALLOW_DECISION)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.phase === "verify-permit",
    );
  });

  it("attaches the decision to verify-permit errors", async () => {
    mockResponse(200, { verified: false, outcome: "permit_consumed" });
    const err = await verifyPermit(BASE_CONFIG, ALLOW_DECISION).catch((e: unknown) => e as EnforceError);
    expect(err.decision).toBe(ALLOW_DECISION);
  });

  // ── Infrastructure errors ────────────────────────────────────────────────────

  it("throws EnforceError(verify-permit) on network error", async () => {
    mockPost.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(verifyPermit(BASE_CONFIG, ALLOW_DECISION)).rejects.toSatisfy(
      (e: EnforceError) =>
        e instanceof EnforceError &&
        e.phase === "verify-permit" &&
        /unreachable/.test(e.message),
    );
  });

  it.each([500, 502, 503])("throws EnforceError(verify-permit) on HTTP %i", async (status) => {
    mockResponse(status, {});
    await expect(verifyPermit(BASE_CONFIG, ALLOW_DECISION)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.phase === "verify-permit",
    );
  });

  it("throws EnforceError(verify-permit) on non-JSON body", async () => {
    mockPost.mockResolvedValueOnce({ status: 200, body: "not-json" });
    await expect(verifyPermit(BASE_CONFIG, ALLOW_DECISION)).rejects.toSatisfy(
      (e: EnforceError) =>
        e instanceof EnforceError &&
        e.phase === "verify-permit" &&
        /Non-JSON/.test(e.message),
    );
  });
});
