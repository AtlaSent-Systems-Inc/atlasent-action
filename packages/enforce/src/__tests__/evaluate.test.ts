import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate, EnforceError } from "../index";

vi.mock("../transport", () => ({ post: vi.fn() }));

import { post } from "../transport";
const mockPost = post as ReturnType<typeof vi.fn>;

const BASE_CONFIG = {
  apiKey: "ask_test_key",
  apiUrl: "https://api.test",
  action: "production_deploy",
  actor: "alice",
};

function mockResponse(status: number, body: unknown) {
  mockPost.mockResolvedValueOnce({ status, body: JSON.stringify(body) });
}

describe("evaluate", () => {
  beforeEach(() => mockPost.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("returns a mapped Decision on a 200 allow response", async () => {
    mockResponse(200, {
      decision: "allow",
      evaluation_id: "ev-1",
      permit_token: "pt-abc",
      proof_hash: "ph-xyz",
      risk_score: 12,
    });
    const d = await evaluate(BASE_CONFIG);
    expect(d.decision).toBe("allow");
    expect(d.evaluationId).toBe("ev-1");
    expect(d.permitToken).toBe("pt-abc");
    expect(d.proofHash).toBe("ph-xyz");
    expect(d.riskScore).toBe(12);
  });

  it("maps canonical risk shape { risk: { score } }", async () => {
    mockResponse(200, { decision: "allow", risk: { score: 77 } });
    const d = await evaluate(BASE_CONFIG);
    expect(d.riskScore).toBe(77);
  });

  it("returns undefined riskScore when neither shape is present", async () => {
    mockResponse(200, { decision: "deny", deny_reason: "blocked" });
    const d = await evaluate(BASE_CONFIG);
    expect(d.riskScore).toBeUndefined();
  });

  it("threads target_id into both top-level and context", async () => {
    mockResponse(200, { decision: "allow" });
    await evaluate({ ...BASE_CONFIG, targetId: "svc-prod" });
    const body = JSON.parse(mockPost.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(body["target_id"]).toBe("svc-prod");
    expect((body["context"] as Record<string, unknown>)["target_id"]).toBe("svc-prod");
  });

  it("throws EnforceError(evaluate) on network error", async () => {
    mockPost.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(evaluate(BASE_CONFIG)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.phase === "evaluate",
    );
  });

  it.each([500, 502, 503])("throws EnforceError(evaluate) on HTTP %i", async (status) => {
    mockResponse(status, {});
    await expect(evaluate(BASE_CONFIG)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.phase === "evaluate",
    );
  });

  it("throws EnforceError(evaluate) on 401", async () => {
    mockResponse(401, {});
    await expect(evaluate(BASE_CONFIG)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.message.includes("Authentication failed"),
    );
  });

  it("throws EnforceError(evaluate) on 429", async () => {
    mockResponse(429, {});
    await expect(evaluate(BASE_CONFIG)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.message.includes("Rate limited"),
    );
  });

  it("throws EnforceError(evaluate) on non-JSON body", async () => {
    mockPost.mockResolvedValueOnce({ status: 200, body: "not-json" });
    await expect(evaluate(BASE_CONFIG)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.message.includes("Non-JSON"),
    );
  });

  it("hits the correct endpoint", async () => {
    mockResponse(200, { decision: "allow" });
    await evaluate(BASE_CONFIG);
    expect(mockPost.mock.calls[0][0]).toBe("https://api.test/v1/evaluate");
  });

  it("sends Authorization header with the api key", async () => {
    mockResponse(200, { decision: "allow" });
    await evaluate(BASE_CONFIG);
    expect((mockPost.mock.calls[0][2] as Record<string, string>)["Authorization"]).toBe(
      "Bearer ask_test_key",
    );
  });

  it("strips trailing slash from apiUrl", async () => {
    mockResponse(200, { decision: "allow" });
    await evaluate({ ...BASE_CONFIG, apiUrl: "https://api.test/" });
    expect(mockPost.mock.calls[0][0]).toBe("https://api.test/v1/evaluate");
  });
});
