import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForTerminalDecision } from "../stream";

// SIM tests for waitForTerminalDecision() — the wait-for-id helper that
// blocks on hold/escalate decisions until an upstream approver resolves them.
// Tests cover both the polling path (v2Streaming=false) and the SSE path
// (v2Streaming=true).

describe("waitForTerminalDecision", () => {
  const fetchMock = vi.fn();

  const BASE_OPTS = {
    apiUrl: "https://api.test",
    apiKey: "ask_test_key",
    evaluationId: "ev-123",
    timeoutMs: 30_000,
    v2Streaming: false,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function pollResp(decision: string) {
    return new Response(
      JSON.stringify({
        evaluation_id: "ev-123",
        decision,
        evaluated_at: "2026-04-30T00:00:00Z",
      }),
      { status: 200 },
    );
  }

  function sseStream(...events: object[]): ReadableStream {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
        controller.close();
      },
    });
  }

  // ── Polling path ─────────────────────────────────────────────────────────────

  it("polling: returns allow immediately when first response is terminal", async () => {
    fetchMock.mockResolvedValueOnce(pollResp("allow"));
    const result = await waitForTerminalDecision(BASE_OPTS);
    expect(result.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1-evaluate/ev-123",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ask_test_key" }),
      }),
    );
  });

  it("polling: returns deny immediately when first response is terminal", async () => {
    fetchMock.mockResolvedValueOnce(pollResp("deny"));
    const result = await waitForTerminalDecision(BASE_OPTS);
    expect(result.decision).toBe("deny");
  });

  it("polling: waits through non-terminal hold, retries after interval, returns allow", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      return Promise.resolve(pollResp(callCount === 1 ? "hold" : "allow"));
    });

    const p = waitForTerminalDecision(BASE_OPTS);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await p;

    expect(result.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polling: retries after transient network error instead of throwing immediately", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve(pollResp("allow"));
    });

    const p = waitForTerminalDecision(BASE_OPTS);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await p;

    expect(result.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polling: throws after timeout without a terminal decision", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(pollResp("hold")));

    const p = waitForTerminalDecision({ ...BASE_OPTS, timeoutMs: 4_999 });
    // Attach rejection handler before advancing time so the rejection is not
    // briefly unhandled when the fake timer fires.
    const check = expect(p).rejects.toThrow(/poll timeout/);
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
  });

  // ── SSE streaming path ────────────────────────────────────────────────────────

  it("stream: returns allow from first SSE event", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream({ evaluation_id: "ev-123", decision: "allow", evaluated_at: "2026-04-30T00:00:00Z" }),
        { status: 200 },
      ),
    );

    const result = await waitForTerminalDecision({ ...BASE_OPTS, v2Streaming: true });

    expect(result.decision).toBe("allow");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v1-evaluate/stream",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("stream: skips non-terminal event and returns the next terminal event", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream(
          { evaluation_id: "ev-123", decision: "hold", evaluated_at: "2026-04-30T00:00:00Z" },
          { evaluation_id: "ev-123", decision: "deny", evaluated_at: "2026-04-30T00:00:01Z" },
        ),
        { status: 200 },
      ),
    );

    const result = await waitForTerminalDecision({ ...BASE_OPTS, v2Streaming: true });

    expect(result.decision).toBe("deny");
  });

  it("stream: sends evaluationId in POST body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream({ evaluation_id: "ev-123", decision: "allow", evaluated_at: "2026-04-30T00:00:00Z" }),
        { status: 200 },
      ),
    );
    await waitForTerminalDecision({ ...BASE_OPTS, v2Streaming: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.evaluationId).toBe("ev-123");
  });

  it("stream: throws on non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error", { status: 500 }));

    await expect(
      waitForTerminalDecision({ ...BASE_OPTS, v2Streaming: true }),
    ).rejects.toThrow(/500/);
  });

  it("polling: fails closed when a terminal response does not echo the requested evaluation ID", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ evaluation_id: "ev-other", decision: "allow" }),
        { status: 200 },
      ),
    );

    await expect(waitForTerminalDecision(BASE_OPTS)).rejects.toThrow(/ID mismatch/);
  });

  it("normalizes snake_case terminal permit fields", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          evaluation_id: "ev-123",
          decision: "allow",
          permit_token: "pt-terminal",
          execution_hash_expected: "sha256:original",
          evaluated_at: "2026-04-30T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const result = await waitForTerminalDecision(BASE_OPTS);
    expect(result.permitToken).toBe("pt-terminal");
    expect(result.executionHashExpected).toBe("sha256:original");
  });
});
