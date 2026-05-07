import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateMany } from "../batch";

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

  it("hits /v1/evaluate/batch when v2Batch=true and verifies allow decisions", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [{ decision: "allow", evaluatedAt: "2026-04-25T00:00:00Z", permitToken: "tok1" }],
          batchId: "b1",
        }),
      ),
    );
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "ok" });

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [{ action: "a", actor: "u" }],
      true,
    );

    expect(out.batchId).toBe("b1");
    expect(out.decisions[0].verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1/evaluate/batch",
      expect.anything(),
    );
    expect(mockVerifyPermit).toHaveBeenCalledOnce();
  });

  it("loops /v1/evaluate when v2Batch=false and verifies each allow decision", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/v1/evaluate")) {
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
      evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }], true),
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
      [{ action: "deploy.prod", actor: "alice" }],
      false,
    );

    expect(mockVerifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "api-key-123",
        apiUrl: "https://api.test",
        action: "deploy.prod",
        actor: "alice",
      }),
      expect.objectContaining({
        decision: "allow",
        permitToken: "tok-xyz",
      }),
    );
  });
});
