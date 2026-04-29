// @atlasent/enforce — fail-closed execution wrapper.
//
// Enforces the evaluate → verify → execute contract:
//   1. evaluate()  — calls POST /v1/evaluate; any infra error blocks execution
//   2. verify()    — rejects non-allow decisions (deny / hold / escalate)
//   3. enforce()   — composes the two; the wrapped function never runs unless
//                    both evaluate and verify succeed

import { post } from "./transport";

const DEFAULT_API_URL = "https://api.atlasent.io";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnforceConfig {
  apiKey: string;
  apiUrl?: string;
  action: string;
  actor: string;
  environment?: string;
  targetId?: string;
  context?: Record<string, unknown>;
}

export interface Decision {
  decision: "allow" | "deny" | "hold" | "escalate";
  evaluationId?: string;
  permitToken?: string;
  proofHash?: string;
  riskScore?: number;
  denyReason?: string;
  holdReason?: string;
}

export type EnforcePhase = "evaluate" | "verify" | "execute";

export class EnforceError extends Error {
  readonly phase: EnforcePhase;
  readonly decision: Decision | null;

  constructor(message: string, phase: EnforcePhase, decision: Decision | null = null) {
    super(message);
    this.name = "EnforceError";
    this.phase = phase;
    this.decision = decision;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — evaluate
// ---------------------------------------------------------------------------

export async function evaluate(config: EnforceConfig): Promise<Decision> {
  const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");

  const payload: Record<string, unknown> = {
    action_type: config.action,
    actor_id: config.actor,
    context: {
      ...(config.environment ? { environment: config.environment } : {}),
      ...(config.targetId ? { target_id: config.targetId } : {}),
      ...config.context,
    },
  };
  if (config.targetId) payload["target_id"] = config.targetId;

  let status: number;
  let body: string;
  try {
    ({ status, body } = await post(`${apiUrl}/v1/evaluate`, JSON.stringify(payload), {
      Authorization: `Bearer ${config.apiKey}`,
    }));
  } catch (err) {
    throw new EnforceError(
      `AtlaSent API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "evaluate",
    );
  }

  if (status >= 500) {
    throw new EnforceError(`Infrastructure failure (HTTP ${status})`, "evaluate");
  }
  if (status === 401 || status === 403) {
    throw new EnforceError(`Authentication failed (HTTP ${status})`, "evaluate");
  }
  if (status === 429) {
    throw new EnforceError("Rate limited (HTTP 429)", "evaluate");
  }
  if (status < 200 || status >= 300) {
    throw new EnforceError(`Unexpected response (HTTP ${status})`, "evaluate");
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new EnforceError("Non-JSON response from AtlaSent API", "evaluate");
  }

  return mapDecision(raw);
}

// ---------------------------------------------------------------------------
// Step 2 — verify
// ---------------------------------------------------------------------------

export function verify(decision: Decision): void {
  switch (decision.decision) {
    case "allow":
      return;
    case "deny":
      throw new EnforceError(
        `Denied: ${decision.denyReason ?? "no reason provided"}`,
        "verify",
        decision,
      );
    case "hold":
      throw new EnforceError(
        `On hold: ${decision.holdReason ?? "awaiting approval"}`,
        "verify",
        decision,
      );
    case "escalate":
      throw new EnforceError("Escalated — manual review required", "verify", decision);
    default:
      throw new EnforceError(
        `Unknown decision: ${String((decision as Decision).decision)}`,
        "verify",
        decision,
      );
  }
}

// ---------------------------------------------------------------------------
// Step 3 — enforce (evaluate → verify → execute, fail-closed)
// ---------------------------------------------------------------------------

export async function enforce<T>(
  config: EnforceConfig,
  fn: () => Promise<T>,
): Promise<{ result: T; decision: Decision }> {
  const decision = await evaluate(config); // throws EnforceError → fn never runs
  verify(decision);                         // throws EnforceError → fn never runs
  const result = await fn();
  return { result, decision };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapDecision(raw: Record<string, unknown>): Decision {
  return {
    decision: raw["decision"] as Decision["decision"],
    evaluationId: raw["evaluation_id"] as string | undefined,
    permitToken: raw["permit_token"] as string | undefined,
    proofHash: raw["proof_hash"] as string | undefined,
    riskScore: extractRiskScore(raw),
    denyReason: raw["deny_reason"] as string | undefined,
    holdReason: raw["hold_reason"] as string | undefined,
  };
}

function extractRiskScore(raw: Record<string, unknown>): number | undefined {
  const risk = raw["risk"];
  if (risk && typeof risk === "object" && "score" in risk) {
    const score = (risk as { score?: unknown }).score;
    if (typeof score === "number") return score;
  }
  const flat = raw["risk_score"];
  if (typeof flat === "number") return flat;
  return undefined;
}
