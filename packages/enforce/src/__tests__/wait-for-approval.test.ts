import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForApprovalResolution, EnforceError } from "../index";

vi.mock("../transport", () => ({ get: vi.fn(), post: vi.fn() }));

import { get } from "../transport";
const mockGet = get as ReturnType<typeof vi.fn>;

const BASE_CONFIG = {
  apiKey: "ask_test_key",
  apiUrl: "https://api.test",
  approvalId: "apr-1",
  maxWaitMs: 30_000,
};

function resp(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

describe("waitForApprovalResolution", () => {
  beforeEach(() => {
    mockGet.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws immediately (fail closed) when no approvalId is supplied", async () => {
    await expect(
      waitForApprovalResolution({ ...BASE_CONFIG, approvalId: "" }),
    ).rejects.toThrow(EnforceError);
  });

  it("polls GET /v1/approvals/:id with the bearer token", async () => {
    mockGet.mockResolvedValueOnce(resp(200, { status: "denied" }));
    await waitForApprovalResolution(BASE_CONFIG);
    expect(mockGet).toHaveBeenCalledWith(
      "https://api.test/v1/approvals/apr-1",
      { Authorization: "Bearer ask_test_key" },
    );
  });

  it("returns approved status with the fresh permit token", async () => {
    mockGet.mockResolvedValueOnce(
      resp(200, {
        status: "approved",
        re_evaluation_decision: "allow",
        re_evaluation_permit_token: "pt.v4.fresh",
      }),
    );
    const result = await waitForApprovalResolution(BASE_CONFIG);
    expect(result).toEqual({
      status: "approved",
      reEvaluationDecision: "allow",
      permitToken: "pt.v4.fresh",
    });
  });

  it("returns approved status with NO permit token honestly when the reevaluation didn't mint one", async () => {
    mockGet.mockResolvedValueOnce(
      resp(200, { status: "approved", re_evaluation_decision: "hold" }),
    );
    const result = await waitForApprovalResolution(BASE_CONFIG);
    expect(result.status).toBe("approved");
    expect(result.permitToken).toBeUndefined();
  });

  it("returns a terminal denied/expired status as-is, uninterpreted", async () => {
    mockGet.mockResolvedValueOnce(resp(200, { status: "denied_by_timeout" }));
    const result = await waitForApprovalResolution(BASE_CONFIG);
    expect(result.status).toBe("denied_by_timeout");
  });

  it("keeps polling while status is pending, then returns on the terminal poll", async () => {
    mockGet
      .mockResolvedValueOnce(resp(200, { status: "pending" }))
      .mockResolvedValueOnce(resp(200, { status: "approved", re_evaluation_permit_token: "pt-x" }));

    const p = waitForApprovalResolution(BASE_CONFIG);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await p;

    expect(result.status).toBe("approved");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("retries after a transient network error instead of throwing immediately", async () => {
    mockGet
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(resp(200, { status: "denied" }));

    const p = waitForApprovalResolution(BASE_CONFIG);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await p;

    expect(result.status).toBe("denied");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("fails closed immediately on 401/403 — auth failures are not transient", async () => {
    mockGet.mockResolvedValueOnce(resp(403, { error: "forbidden" }));
    await expect(waitForApprovalResolution(BASE_CONFIG)).rejects.toThrow(/authentication failed/i);
  });

  it("fails closed immediately on 404 — an unknown approval id is not worth retrying", async () => {
    mockGet.mockResolvedValueOnce(resp(404, { error: "not_found" }));
    await expect(waitForApprovalResolution(BASE_CONFIG)).rejects.toThrow(/not found/i);
  });

  it("throws a timeout error (fail closed) when the deadline elapses with no terminal status", async () => {
    mockGet.mockImplementation(() => Promise.resolve(resp(200, { status: "pending" })));

    const p = waitForApprovalResolution({ ...BASE_CONFIG, maxWaitMs: 4_999 });
    const check = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
  });
});
