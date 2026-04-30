import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateMany } from "../batch";

describe("evaluateMany", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
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

  function verifyResp(verified = true, outcome = "ok") {
    return new Response(JSON.stringify({ verified, outcome }));
  }

  it("hits /v1/evaluate/batch when v2Batch=true and verifies allow decisions", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ decision: "allow", evaluatedAt: "2026-04-25T00:00:00Z", permitToken: "tok1" }],
            batchId: "b1",
          }),
        ),
      )
      // verify call for the allow decision
      .mockResolvedValueOnce(verifyResp(true, "ok"));

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
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1/verify-permit",
      expect.anything(),
    );
  });

  it("loops /v1/evaluate when v2Batch=false and verifies each allow decision", async () => {
    fetchMock
      .mockImplementation((url: string) => {
        if (url.endsWith("/v1/evaluate")) {
          return Promise.resolve(evalResp("allow", "tok1"));
        }
        if (url.endsWith("/v1/verify-permit")) {
          return Promise.resolve(verifyResp(true));
        }
        return Promise.reject(new Error(`unexpected url: ${url}`));
      });

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

  it("deny decisions are not verified (no verify call)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ decision: "deny", evaluatedAt: "2026-04-25T00:00:00Z" }))),
    );

    const out = await evaluateMany(
      "https://api.test",
      "k",
      [{ action: "a", actor: "u" }],
      false,
    );

    // only the evaluate call — no verify call for deny
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.decisions[0].decision).toBe("deny");
    expect(out.decisions[0].verified).toBeUndefined();
  });

  it("allow with no permitToken → verified=false (no verify call)", async () => {
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
    // no verify call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on non-2xx batch response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(
      evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }], true),
    ).rejects.toThrow(/500/);
  });

  it("throws on verify 5xx (fail-closed)", async () => {
    fetchMock
      .mockResolvedValueOnce(evalResp("allow", "tok1"))
      .mockResolvedValueOnce(new Response("err", { status: 500 }));

    await expect(
      evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }], false),
    ).rejects.toThrow(/verify-permit HTTP 500/);
  });
});
