// Wave B.AC3 — streaming-wait helper.
//
// Consumes /v1-evaluate/stream Server-Sent Events for the duration of
// a change_window approval. Resolves with the first terminal decision
// (allow / deny) for the watched evaluation id, or rejects on timeout.
//
// When the per-tenant `v2_streaming` flag is off, falls back to
// polling /v1-evaluate/:id every 5 seconds.

import type { Decision } from "./types";

const POLL_INTERVAL_MS = 5_000;
const SSE_LINE = /^data: (.+)$/;

class ApprovalResponseBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalResponseBindingError";
  }
}

export interface WaitOptions {
  apiUrl: string;
  apiKey: string;
  evaluationId: string;
  timeoutMs: number;
  v2Streaming: boolean;
  signal?: AbortSignal;
}

/**
 * Normalize the two runtime response shapes used by the approval wait
 * endpoints. `/v1-evaluate` uses snake_case; the older streaming preview
 * used camelCase. Keeping the conversion at the transport edge prevents a
 * terminal allow from being mistaken for an allow-without-permit.
 */
function parseDecision(raw: unknown): Decision | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const decision = value["decision"];
  if (
    decision !== "allow" &&
    decision !== "deny" &&
    decision !== "hold" &&
    decision !== "escalate"
  ) {
    return null;
  }

  const string = (key: string): string | undefined =>
    typeof value[key] === "string" ? value[key] : undefined;
  const number = (key: string): number | undefined =>
    typeof value[key] === "number" ? value[key] : undefined;
  const rawReasons = value["reasons"];
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((reason: unknown): reason is string => typeof reason === "string")
    : undefined;

  return {
    id: string("evaluation_id") ?? string("evaluationId") ?? string("id"),
    decision,
    permitToken: string("permit_token") ?? string("permitToken"),
    proofHash: string("proof_hash") ?? string("proofHash"),
    executionHashExpected:
      string("execution_hash_expected") ??
      string("executionHashExpected") ??
      string("payload_hash"),
    denyReason: string("deny_reason") ?? string("denyReason"),
    holdReason: string("hold_reason") ?? string("holdReason"),
    auditHash: string("audit_entry_hash") ?? string("audit_hash") ?? string("auditHash"),
    riskScore: number("risk_score") ?? number("riskScore"),
    reasons,
    evaluatedAt:
      string("evaluated_at") ?? string("evaluatedAt") ?? new Date().toISOString(),
  };
}

function terminalDecision(raw: unknown, evaluationId: string): Decision | null {
  const decision = parseDecision(raw);
  if (!decision || (decision.decision !== "allow" && decision.decision !== "deny")) {
    return null;
  }
  // The URL already addresses this evaluation, but requiring the response to
  // echo the same ID makes the binding explicit and catches a wrong response
  // before a newly-issued permit could be consumed.
  if (!decision.id || decision.id !== evaluationId) {
    throw new ApprovalResponseBindingError(
      `atlasent approval response evaluation ID mismatch (expected ${evaluationId}, got ${decision.id ?? "missing"})`,
    );
  }
  return decision;
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
  const r = await fetch(`${opts.apiUrl}/v1-evaluate/stream`, {
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
    throw new Error(`atlasent /v1-evaluate/stream ${r.status}`);
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
        let raw: unknown;
        try {
          raw = JSON.parse(m[1]);
        } catch {
          continue;
        }
        const event = terminalDecision(raw, opts.evaluationId);
        if (event) {
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
    try {
      const r = await fetch(
        `${opts.apiUrl}/v1-evaluate/${encodeURIComponent(opts.evaluationId)}`,
        {
          headers: { authorization: `Bearer ${opts.apiKey}` },
          signal: opts.signal,
        },
      );
      if (r.ok) {
        const decision = terminalDecision(await r.json(), opts.evaluationId);
        if (decision) {
          return decision;
        }
      }
    } catch (err) {
      // Re-throw AbortError (caller cancelled); swallow transient network /
      // parse errors and let the next poll attempt handle them.
      if (
        err instanceof ApprovalResponseBindingError ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw err;
      }
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(
    `atlasent poll timeout after ${opts.timeoutMs}ms for ${opts.evaluationId}`,
  );
}
