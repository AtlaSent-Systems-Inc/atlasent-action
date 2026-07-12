// @atlasent/enforce — fail-closed execution wrapper.
//
// Enforces the evaluate → verify → verifyPermit → execute contract:
//   1. evaluate()     — calls POST /v1-evaluate; any infra error blocks execution
//   2. verify()       — rejects non-allow decisions (deny / hold / escalate)
//   3. verifyPermit() — calls POST /v1-verify-permit; replay/expired tokens block
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
  resource?: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
  };
  current_state?: { description: string; attributes?: Record<string, unknown> };
  proposed_state?: { description: string; attributes?: Record<string, unknown> };
  execution_binding?: {
    kind: string;
    adapter_version?: string;
    resource_id?: string;
    enforcement_point?: string;
  };
  context?: Record<string, unknown>;
  /** Top-level body field required when the action class has requires_state_snapshot=true.
   *  Must be sent alongside context, not nested inside it. */
  state_snapshot?: {
    source?: string;
    source_kind?: string;
    complete?: boolean;
    run_id?: string;
    payload?: unknown;
  };
  /**
   * SHA-256 digest of the artifact being authorized (canonical input, NOT
   * presentation metadata). Sent to evaluate as the top-level
   * `execution_payload_hash`, which the runtime binds into the permit
   * (`execution_hash_expected`). Re-presented at verify time as `payload_hash`
   * — a permit issued for one artifact then presented for another fails with
   * `PAYLOAD_MISMATCH`. This is what stops a workflow evaluating one artifact
   * and executing a different one.
   */
  executionPayloadHash?: string;
}

export interface Decision {
  decision: "allow" | "deny" | "hold" | "escalate";
  evaluationId?: string;
  permitToken?: string;
  proofHash?: string;
  riskScore?: number;
  denyReason?: string;
  /** Machine deny code (e.g. INSUFFICIENT_APPROVALS), present on deny. */
  denyCode?: string;
  /**
   * Additive remediation hint the runtime attaches to common, safe-to-disclose
   * denies — tells the caller how to fix it. Surfaced verbatim; never used for
   * a decision.
   */
  remediation?: { summary?: string; how_to?: string[]; docs?: string };
  holdReason?: string;
  /** Resolved risk class from the evaluation (critical / high / medium / low). */
  risk_class?: string;
  /** WHY this was allowed — kind + reference ID (policy, quorum, emergency, etc.). */
  authority_basis?: { kind: string; reference?: string; granted_by?: string; rationale?: string };
  /**
   * Present iff decision === "hold". ID of the HITL escalation auto-created by
   * the control plane. Poll GET /v1/hitl/{id} for resolution.
   */
  escalation_id?: string;
  /** v1.1 audit chain fields — present when the API returns them. */
  chainEntry?: Record<string, unknown> | null;
  snapshot?: Record<string, unknown> | null;
  auditHash?: string;
}

export interface VerifyPermitResult {
  verified: boolean;
  outcome?: string;
  /** Precise runtime wire code (e.g. PAYLOAD_MISMATCH, PERMIT_EXPIRED). */
  verifyErrorCode?: string;
  /** Fields that diverged between the presented context and the bound permit. */
  mismatchFields?: string[];
}

export type EnforcePhase = "evaluate" | "verify" | "verify-permit" | "execute";

export class EnforceError extends Error {
  readonly phase: EnforcePhase;
  readonly decision: Decision | null;
  /** Coarse verify outcome (verified | mismatch | expired | replay_blocked | invalid | …). */
  readonly outcome?: string;
  /** Precise verify wire code, when the failure came from verify-permit. */
  readonly verifyErrorCode?: string;
  readonly mismatchFields?: string[];

  constructor(
    message: string,
    phase: EnforcePhase,
    decision: Decision | null = null,
    details?: { outcome?: string; verifyErrorCode?: string; mismatchFields?: string[] },
  ) {
    super(message);
    this.name = "EnforceError";
    this.phase = phase;
    this.decision = decision;
    this.outcome = details?.outcome;
    this.verifyErrorCode = details?.verifyErrorCode;
    this.mismatchFields = details?.mismatchFields;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — evaluate
// ---------------------------------------------------------------------------

export async function evaluate(config: EnforceConfig): Promise<Decision> {
  const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");

  // Separate state_snapshot out of context if the caller mistakenly nested it there.
  const rawContext = { ...config.context };
  const contextSnapshot = rawContext["state_snapshot"] as EnforceConfig["state_snapshot"] | undefined;
  delete rawContext["state_snapshot"];

  const payload: Record<string, unknown> = {
    action_type: config.action,
    actor_id: config.actor,
    context: {
      // Keep environment in context for backward compat with older control plane versions.
      ...(config.environment ? { environment: config.environment } : {}),
      ...(config.targetId ? { target_id: config.targetId } : {}),
      ...rawContext,
    },
  };
  // Top-level fields forwarded to the control plane's EvaluateRequest.
  if (config.environment != null) payload["environment"] = config.environment;
  if (config.resource != null) payload["resource"] = config.resource;
  else if (config.targetId) payload["target_id"] = config.targetId;
  if (config.current_state != null) payload["current_state"] = config.current_state;
  if (config.proposed_state != null) payload["proposed_state"] = config.proposed_state;
  if (config.execution_binding != null) payload["execution_binding"] = config.execution_binding;
  // state_snapshot is a top-level body field (EvaluateBody.state_snapshot), not inside context.
  const snap = config.state_snapshot ?? contextSnapshot;
  if (snap != null) payload["state_snapshot"] = snap;
  // Artifact digest is a canonical top-level input — the runtime binds it into
  // the permit (execution_hash_expected). Never buried in context/presentation.
  if (config.executionPayloadHash != null) {
    payload["execution_payload_hash"] = config.executionPayloadHash;
  }

  let status: number;
  let body: string;
  try {
    ({ status, body } = await post(`${apiUrl}/v1-evaluate`, JSON.stringify(payload), {
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
// Step 3 — verifyPermit (calls /v1-verify-permit, fail-closed)
//
// Without this round-trip the enforce wrapper is evaluate-only: a tampered or
// replayed permit_token would still surface decision=allow. This step consumes
// the token — downstream re-verify returns outcome=permit_consumed.
// ---------------------------------------------------------------------------

interface RawVerify {
  valid?: boolean;
  verified?: boolean; // legacy field name — accepted for backward compat
  outcome?: string;
  verify_error_code?: string;
  mismatch_fields?: string[];
}

/**
 * Shared HTTP core for permit verification. Sends the permit token AND re-binds
 * the execution context (environment, target, artifact digest) so verification
 * checks the caller is executing the SAME artifact/environment the permit was
 * issued for. Returns a normalized result (does not throw on verified=false —
 * the caller applies the fail-closed decision).
 */
async function postVerify(
  config: EnforceConfig,
  permitToken: string,
  decision: Decision | null,
): Promise<VerifyPermitResult> {
  const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");

  const bodyObj: Record<string, unknown> = {
    permit_token: permitToken,
    action_type: config.action,
    actor_id: config.actor,
  };
  if (config.environment != null) bodyObj["environment"] = config.environment;
  if (config.targetId != null) bodyObj["target_id"] = config.targetId;
  if (config.executionPayloadHash != null) bodyObj["payload_hash"] = config.executionPayloadHash;

  let status: number;
  let body: string;
  try {
    ({ status, body } = await post(`${apiUrl}/v1-verify-permit`, JSON.stringify(bodyObj), {
      Authorization: `Bearer ${config.apiKey}`,
    }));
  } catch (err) {
    throw new EnforceError(
      `verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "verify-permit",
      decision,
    );
  }

  if (status >= 500) {
    throw new EnforceError(`verify-permit infrastructure failure (HTTP ${status})`, "verify-permit", decision);
  }
  if (status < 200 || status >= 300) {
    throw new EnforceError(`verify-permit failed (HTTP ${status})`, "verify-permit", decision);
  }

  let raw: RawVerify;
  try {
    raw = JSON.parse(body) as RawVerify;
  } catch {
    throw new EnforceError("Non-JSON response from verify-permit", "verify-permit", decision);
  }

  // Runtime wire field is `valid`; older responses used `verified`. Accept both.
  const ok = raw.valid ?? raw.verified;
  return {
    verified: ok === true,
    outcome: raw.outcome,
    verifyErrorCode: raw.verify_error_code,
    mismatchFields: Array.isArray(raw.mismatch_fields) ? raw.mismatch_fields : undefined,
  };
}

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

  const r = await postVerify(config, decision.permitToken, decision);
  if (!r.verified) {
    // outcome=replay_blocked (replay), expired, mismatch (wrong artifact/env), etc.
    throw new EnforceError(
      `Permit verification failed (outcome=${r.outcome ?? "unknown"}${r.verifyErrorCode ? `, code=${r.verifyErrorCode}` : ""})`,
      "verify-permit",
      decision,
      { outcome: r.outcome, verifyErrorCode: r.verifyErrorCode, mismatchFields: r.mismatchFields },
    );
  }
  return r;
}

// ---------------------------------------------------------------------------
// Step 3b — reverifyPermit (re-verify at the EXECUTION BOUNDARY)
//
// Re-verify an already-issued permit immediately before the protected step,
// independent of the gate that issued it — so a workflow cannot evaluate one
// artifact and execute another, and a missing / modified / expired / replayed /
// context-mismatched permit fails closed AT THE BOUNDARY. Pass the artifact
// digest via config.executionPayloadHash and the environment via config.environment.
// ---------------------------------------------------------------------------

export async function reverifyPermit(
  config: EnforceConfig,
  permitToken: string,
): Promise<VerifyPermitResult> {
  if (!permitToken || !permitToken.trim()) {
    throw new EnforceError(
      "no permit_token presented at execution boundary — refusing to execute",
      "verify-permit",
      null,
      { outcome: "invalid", verifyErrorCode: "MISSING_PERMIT" },
    );
  }
  const r = await postVerify(config, permitToken, null);
  if (!r.verified) {
    throw new EnforceError(
      `Permit re-verification failed at execution boundary (outcome=${r.outcome ?? "unknown"}${r.verifyErrorCode ? `, code=${r.verifyErrorCode}` : ""})`,
      "verify-permit",
      null,
      { outcome: r.outcome, verifyErrorCode: r.verifyErrorCode, mismatchFields: r.mismatchFields },
    );
  }
  return r;
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
    denyCode: raw["deny_code"] as string | undefined,
    remediation: raw["remediation"] as Decision["remediation"] | undefined,
    holdReason: raw["hold_reason"] as string | undefined,
    risk_class: raw["risk_class"] as string | undefined,
    authority_basis: raw["authority_basis"] as Decision["authority_basis"],
    escalation_id: raw["escalation_id"] as string | undefined,
    chainEntry: (raw["chain_entry"] as Record<string, unknown> | null | undefined) ?? null,
    snapshot: (raw["snapshot"] as Record<string, unknown> | null | undefined) ?? null,
    auditHash: raw["audit_hash"] as string | undefined,
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
