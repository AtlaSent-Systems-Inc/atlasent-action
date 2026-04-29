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

  it("hits /v1/evaluate/batch when v2Batch=true", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              decision: "allow",
              evaluatedAt: "2026-04-25T00:00:00Z",
            },
          ],
          batchId: "b1",
        }),
      ),
    );
    const out = await evaluateMany(
      "https://api.test",
      "k",
      [{ action: "a", actor: "u" }],
      true,
    );
    expect(out.batchId).toBe("b1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1/evaluate/batch",
      expect.anything(),
    );
  });

  it("loops /v1/evaluate when v2Batch=false", async () => {
    const body = JSON.stringify({ decision: "allow", evaluatedAt: "2026-04-25T00:00:00Z" });
    // Each call needs a fresh Response — the body stream can only be consumed once
    fetchMock.mockResolvedValue(undefined);
    fetchMock.mockImplementation(() => Promise.resolve(new Response(body)));
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.batchId).toMatch(/^loop-/);
  });

  it("throws on non-2xx batch response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(
      evaluateMany("https://api.test", "k", [{ action: "a", actor: "u" }], true),
    ).rejects.toThrow(/500/);
  });
});
