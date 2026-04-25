// Wave B.AC3 — streaming-wait helper.
//
// Consumes /v1/evaluate/stream Server-Sent Events for the duration of
// a change_window approval. Resolves with the first terminal decision
// (allow / deny) for the watched evaluation id, or rejects on timeout.
//
// When the per-tenant `v2_streaming` flag is off, falls back to
// polling /v1/evaluate/:id every 5 seconds.

import type { Decision } from "./types";

const POLL_INTERVAL_MS = 5_000;
const SSE_LINE = /^data: (.+)$/;

export interface WaitOptions {
  apiUrl: string;
  apiKey: string;
  evaluationId: string;
  timeoutMs: number;
  v2Streaming: boolean;
  signal?: AbortSignal;
}

export async function waitForTerminalDecision(
  opts: WaitOptions,
): Promise<Decision> {
  if (opts.v2Streaming) {
    return waitViaStream(opts);
  }
  return waitViaPolling(opts);
}

async function waitViaStream(opts: WaitOptions): Promise<Decision> {
  const r = await fetch(`${opts.apiUrl}/v1/evaluate/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({ evaluationId: opts.evaluationId }),
    signal: opts.signal,
  });
  if (!r.ok || !r.body) {
    throw new Error(`atlasent /v1/evaluate/stream ${r.status}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + opts.timeoutMs;
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        const m = SSE_LINE.exec(line);
        if (!m) continue;
        const event = JSON.parse(m[1]) as Decision;
        if (event.decision === "allow" || event.decision === "deny") {
          return event;
        }
      }
    }
  }
  throw new Error(
    `atlasent stream timeout after ${opts.timeoutMs}ms for ${opts.evaluationId}`,
  );
}

async function waitViaPolling(opts: WaitOptions): Promise<Decision> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(
      `${opts.apiUrl}/v1/evaluate/${encodeURIComponent(opts.evaluationId)}`,
      {
        headers: { authorization: `Bearer ${opts.apiKey}` },
        signal: opts.signal,
      },
    );
    if (r.ok) {
      const decision = (await r.json()) as Decision;
      if (decision.decision === "allow" || decision.decision === "deny") {
        return decision;
      }
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(
    `atlasent poll timeout after ${opts.timeoutMs}ms for ${opts.evaluationId}`,
  );
}
