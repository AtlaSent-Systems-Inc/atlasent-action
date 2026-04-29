import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforce, EnforceError } from "../index";
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

// Raw API response shapes (snake_case) used for mock HTTP bodies
const ALLOW_RESPONSE = { decision: "allow", evaluation_id: "ev-1", permit_token: "pt-abc" };
const DENY_RESPONSE = { decision: "deny", deny_reason: "policy blocked" };

function mockResponse(status: number, body: unknown) {
  mockPost.mockResolvedValueOnce({ status, body: JSON.stringify(body) });
}

describe("enforce — contract invariants", () => {
  beforeEach(() => mockPost.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("executes fn and returns { result, decision } when allow", async () => {
    mockResponse(200, ALLOW_RESPONSE);
    const fn = vi.fn().mockResolvedValue("deployed");
    const out = await enforce(BASE_CONFIG, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(out.result).toBe("deployed");
    expect(out.decision.decision).toBe("allow");
    expect(out.decision.permitToken).toBe("pt-abc");
  });

  it("fn never runs when evaluate throws (network failure)", async () => {
    mockPost.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const fn = vi.fn();
    await expect(enforce(BASE_CONFIG, fn)).rejects.toBeInstanceOf(EnforceError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fn never runs when evaluate throws (5xx)", async () => {
    mockResponse(500, {});
    const fn = vi.fn();
    await expect(enforce(BASE_CONFIG, fn)).rejects.toBeInstanceOf(EnforceError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fn never runs when verify throws (deny)", async () => {
    mockResponse(200, DENY_RESPONSE);
    const fn = vi.fn();
    await expect(enforce(BASE_CONFIG, fn)).rejects.toSatisfy(
      (e: EnforceError) => e instanceof EnforceError && e.phase === "verify",
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("fn never runs when verify throws (hold)", async () => {
    mockResponse(200, { decision: "hold" });
    const fn = vi.fn();
    await expect(enforce(BASE_CONFIG, fn)).rejects.toBeInstanceOf(EnforceError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fn never runs when verify throws (escalate)", async () => {
    mockResponse(200, { decision: "escalate" });
    const fn = vi.fn();
    await expect(enforce(BASE_CONFIG, fn)).rejects.toBeInstanceOf(EnforceError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("propagates fn errors naturally after a successful allow", async () => {
    mockResponse(200, ALLOW_RESPONSE);
    const boom = new Error("deploy exploded");
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(enforce(BASE_CONFIG, fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("error from evaluate phase carries null decision", async () => {
    mockResponse(401, {});
    const fn = vi.fn();
    const err = await enforce(BASE_CONFIG, fn).catch((e: unknown) => e as EnforceError);
    expect(err).toBeInstanceOf(EnforceError);
    expect(err.phase).toBe("evaluate");
    expect(err.decision).toBeNull();
  });

  it("error from verify phase carries the decision", async () => {
    mockResponse(200, DENY_RESPONSE);
    const fn = vi.fn();
    const err = await enforce(BASE_CONFIG, fn).catch((e: unknown) => e as EnforceError);
    expect(err).toBeInstanceOf(EnforceError);
    expect(err.phase).toBe("verify");
    expect(err.decision?.decision).toBe("deny");
  });
});
