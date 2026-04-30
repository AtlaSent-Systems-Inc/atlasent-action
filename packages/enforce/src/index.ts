// @atlasent/enforce — fail-closed execution wrapper.
//
// Enforces the evaluate → verify → verifyPermit → execute contract:
//   1. evaluate()     — calls POST /v1/evaluate; any infra error blocks execution
//   2. verify()       — rejects non-allow decisions (deny / hold / escalate)
//   3. verifyPermit() — calls POST /v1/verify-permit; replay/expired tokens block
//   4. enforce()      — composes all three; fn never runs unless all steps pass

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

export interface VerifyPermitResult {
  verified: boolean;
  outcome?: string;
}

export type EnforcePhase = "evaluate" | "verify" | "verify-permit" | "execute";

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
// Step 2 — verify (decision check — no HTTP call)
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
// Step 3 — verifyPermit (calls /v1/verify-permit, fail-closed)
//
// Without this round-trip the enforce wrapper is evaluate-only: a tampered or
// replayed permit_token would still surface decision=allow. This step consumes
// the token — downstream re-verify returns outcome=permit_consumed.
// ---------------------------------------------------------------------------

export async function verifyPermit(
  config: EnforceConfig,
  decision: Decision,
): Promise<VerifyPermitResult> {
  if (!decision.permitToken) {
    throw new EnforceError(
      "evaluate returned allow but no permit_token — refusing to execute without verifiable permit",
      "verify-permit",
      decision,
    );
  }

  const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");

  let status: number;
  let body: string;
  try {
    ({ status, body } = await post(
      `${apiUrl}/v1/verify-permit`,
      JSON.stringify({
        permit_token: decision.permitToken,
        action_type: config.action,
        actor_id: config.actor,
      }),
      { Authorization: `Bearer ${config.apiKey}` },
    ));
  } catch (err) {
    throw new EnforceError(
      `verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "verify-permit",
      decision,
    );
  }

  if (status >= 500) {
    throw new EnforceError(
      `verify-permit infrastructure failure (HTTP ${status})`,
      "verify-permit",
      decision,
    );
  }
  if (status < 200 || status >= 300) {
    throw new EnforceError(
      `verify-permit failed (HTTP ${status})`,
      "verify-permit",
      decision,
    );
  }

  let raw: { verified?: boolean; outcome?: string };
  try {
    raw = JSON.parse(body) as { verified?: boolean; outcome?: string };
  } catch {
    throw new EnforceError(
      "Non-JSON response from verify-permit",
      "verify-permit",
      decision,
    );
  }

  if (raw.verified !== true) {
    // outcome=permit_consumed (replay), permit_expired, etc.
    throw new EnforceError(
      `Permit verification failed (outcome=${raw.outcome ?? "unknown"})`,
      "verify-permit",
      decision,
    );
  }

  return { verified: true, outcome: raw.outcome };
}

// ---------------------------------------------------------------------------
// Step 4 — enforce (evaluate → verify → verifyPermit → execute, fail-closed)
// ---------------------------------------------------------------------------

export async function enforce<T>(
  config: EnforceConfig,
  fn: () => Promise<T>,
): Promise<{ result: T; decision: Decision; verifyOutcome?: string }> {
  const decision = await evaluate(config);   // throws EnforceError → fn never runs
  verify(decision);                          // throws EnforceError → fn never runs
  const vp = await verifyPermit(config, decision); // throws EnforceError → fn never runs
  const result = await fn();
  return { result, decision, verifyOutcome: vp.outcome };
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
