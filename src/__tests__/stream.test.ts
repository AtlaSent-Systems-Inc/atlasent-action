import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForTerminalDecision } from "../stream";

const BASE = {
  apiUrl: "https://api.test",
  apiKey: "k",
  evaluationId: "ev-1",
  timeoutMs: 30_000,
};

function dec(decision: string) {
  return { decision, evaluatedAt: "2026-04-29T00:00:00Z" };
}

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function sseResponse(events: object[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("waitForTerminalDecision", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Polling path (v2Streaming=false)
  // ---------------------------------------------------------------------------

  describe("polling path", () => {
    const opts = { ...BASE, v2Streaming: false };

    it("returns immediately on allow", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(dec("allow")));
      const d = await waitForTerminalDecision(opts);
      expect(d.decision).toBe("allow");
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("returns on deny", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(dec("deny")));
      const d = await waitForTerminalDecision(opts);
      expect(d.decision).toBe("deny");
    });

    it("polls again after hold and returns allow", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(dec("hold")))
        .mockResolvedValueOnce(jsonResponse(dec("allow")));
      const promise = waitForTerminalDecision(opts);
      await vi.runAllTimersAsync();
      const d = await promise;
      expect(d.decision).toBe("allow");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("continues polling on non-ok response", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response("err", { status: 500 }))
        .mockResolvedValueOnce(jsonResponse(dec("allow")));
      const promise = waitForTerminalDecision(opts);
      await vi.runAllTimersAsync();
      const d = await promise;
      expect(d.decision).toBe("allow");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws poll timeout when deadline is already past", async () => {
      await expect(
        waitForTerminalDecision({ ...opts, timeoutMs: 0 }),
      ).rejects.toThrow(/poll timeout/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("hits GET /v1/evaluate/:id with URL-encoded evaluation id", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(dec("allow")));
      await waitForTerminalDecision({ ...opts, evaluationId: "ev/abc" });
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.test/v1/evaluate/ev%2Fabc",
      );
    });

    it("sends Authorization header", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(dec("allow")));
      await waitForTerminalDecision(opts);
      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers["authorization"]).toBe("Bearer k");
    });
  });

  // ---------------------------------------------------------------------------
  // SSE path (v2Streaming=true)
  // ---------------------------------------------------------------------------

  describe("SSE path", () => {
    const opts = { ...BASE, v2Streaming: true };

    it("returns on allow event", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse([dec("allow")]));
      const d = await waitForTerminalDecision(opts);
      expect(d.decision).toBe("allow");
    });

    it("returns on deny event", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse([dec("deny")]));
      const d = await waitForTerminalDecision(opts);
      expect(d.decision).toBe("deny");
    });

    it("skips non-terminal events and resolves on allow", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([dec("hold"), dec("escalate"), dec("allow")]),
      );
      const d = await waitForTerminalDecision(opts);
      expect(d.decision).toBe("allow");
    });

    it("throws when response is not ok", async () => {
      fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
      await expect(waitForTerminalDecision(opts)).rejects.toThrow(/403/);
    });

    it("throws stream timeout when stream closes without terminal event", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse([]));
      await expect(waitForTerminalDecision(opts)).rejects.toThrow(/stream timeout/);
    });

    it("throws stream timeout when only non-terminal events arrive", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse([dec("hold")]));
      await expect(waitForTerminalDecision(opts)).rejects.toThrow(/stream timeout/);
    });

    it("POSTs to /v1/evaluate/stream with evaluationId in body", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse([dec("allow")]));
      await waitForTerminalDecision(opts);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/v1/evaluate/stream");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).evaluationId).toBe("ev-1");
    });

    it("sends accept: text/event-stream header", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse([dec("allow")]));
      await waitForTerminalDecision(opts);
      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers["accept"]).toBe("text/event-stream");
    });
  });
});
