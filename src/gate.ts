// Core evaluate → verify-permit gate logic.
// Uses fetch (Node 20+ built-in) so unit tests can stub it without real HTTP.
// src/index.ts delegates all HTTP to this module; GH Actions I/O stays there.

export interface GateParams {
  apiUrl: string;
  apiKey: string;
  actionType: string;
  actorId: string;
  /** Full evaluate payload (action_type, actor_id, context, …). */
  payload: Record<string, unknown>;
}

// Discriminated union: ok=true → evaluate=allow AND verify=true.
// ok=false → any non-allow decision OR verify=false (replay/expired).
export type GateResult =
  | {
      ok: true;
      decision: "allow";
      verified: true;
      permitToken: string;
      evaluationId: string;
      proofHash: string;
      riskScore: string;
      verifyOutcome: string;
    }
  | {
      ok: false;
      decision: string;
      verified: false;
      permitToken: string;
      evaluationId: string;
      proofHash: string;
      riskScore: string;
      /** Human-readable reason (deny_reason / hold_reason / verify outcome). */
      reason: string;
      verifyOutcome?: string;
    };

// Thrown for infrastructure failures (network, 5xx, 401, 429, no permit_token).
// Distinct from a policy decision so callers can always fail-closed on these.
export class GateInfraError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GateInfraError";
  }
}

// ---------------------------------------------------------------------------
// Standalone verify step (used by both runGate and the v2.1 batch path)
// ---------------------------------------------------------------------------

export interface VerifyParams {
  apiUrl: string;
  apiKey: string;
  actionType: string;
  actorId: string;
  permitToken: string;
  /** Override the default verify endpoint path. Defaults to /v1-verify-permit
   *  (Supabase style). Pass "/v1/verify-permit" for the conventional REST API. */
  verifyPath?: string;
}

export interface VerifyResult {
  verified: boolean;
  outcome?: string;
}

export async function verifyOne(params: VerifyParams): Promise<VerifyResult> {
  const path = params.verifyPath ?? "/v1-verify-permit";
  let res: Response;
  try {
    res = await fetch(`${params.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        permit_token: params.permitToken,
        action_type: params.actionType,
        actor_id: params.actorId,
      }),
    });
  } catch (err) {
    throw new GateInfraError(
      `verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new GateInfraError(`verify-permit HTTP ${res.status}`, res.status);
  }

  let body: { verified?: boolean; outcome?: string };
  try {
    body = (await res.json()) as { verified?: boolean; outcome?: string };
  } catch {
    throw new GateInfraError("failed to parse verify-permit response as JSON");
  }

  return { verified: body.verified === true, outcome: body.outcome };
}

// ---------------------------------------------------------------------------
// Main gate function
// ---------------------------------------------------------------------------

export async function runGate(params: GateParams): Promise<GateResult> {
  // Step 1 — call /v1-evaluate
  let evalRes: Response;
  try {
    evalRes = await fetch(`${params.apiUrl}/v1-evaluate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(params.payload),
    });
  } catch (err) {
    throw new GateInfraError(
      `evaluate unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Infrastructure errors are always fail-closed — do not confuse with policy.
  if (evalRes.status >= 500) {
    throw new GateInfraError(
      `evaluate HTTP ${evalRes.status} — infrastructure failure, not a policy decision`,
      evalRes.status,
    );
  }
  if (evalRes.status === 401 || evalRes.status === 403) {
    throw new GateInfraError(
      `evaluate auth failed (HTTP ${evalRes.status}). Check ATLASENT_API_KEY scopes.`,
      evalRes.status,
    );
  }
  if (evalRes.status === 429) {
    throw new GateInfraError(
      `evaluate rate-limited (HTTP 429). Retry or raise rate_limit_per_minute.`,
      429,
    );
  }
  if (!evalRes.ok) {
    throw new GateInfraError(`evaluate HTTP ${evalRes.status}`, evalRes.status);
  }

  let evalBody: Record<string, unknown>;
  try {
    evalBody = (await evalRes.json()) as Record<string, unknown>;
  } catch {
    throw new GateInfraError("failed to parse evaluate response as JSON");
  }

  const decision = (evalBody["decision"] as string | undefined) ?? "unknown";
  const permitToken = (evalBody["permit_token"] as string | undefined) ?? "";
  const evaluationId = (evalBody["evaluation_id"] as string | undefined) ?? "";
  const proofHash = (evalBody["proof_hash"] as string | undefined) ?? "";
  const riskScore = extractRiskScore(evalBody);

  // Non-allow decisions → no verify needed, return immediately.
  if (decision !== "allow") {
    const reason =
      (evalBody["deny_reason"] as string | undefined) ??
      (evalBody["hold_reason"] as string | undefined) ??
      "";
    return { ok: false, decision, verified: false, permitToken, evaluationId, proofHash, riskScore, reason };
  }

  // Step 2 — verify-permit (fail-closed: must succeed for gate to open).
  // Without this round-trip the gate is evaluate-only: a tampered or replayed
  // permit_token would still surface decision=allow. This matches the SDK's
  // withPermit (TS) / with_permit (Python) contract.
  if (!permitToken) {
    throw new GateInfraError(
      `evaluate=allow but no permit_token — refusing to gate-open without a verifiable permit (evaluation: ${evaluationId})`,
    );
  }

  const verify = await verifyOne({
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    actionType: params.actionType,
    actorId: params.actorId,
    permitToken,
  });

  if (!verify.verified) {
    // outcome=permit_consumed (replay), permit_expired, etc.
    return {
      ok: false,
      decision: "allow",
      verified: false,
      permitToken,
      evaluationId,
      proofHash,
      riskScore,
      reason: `permit verification failed (outcome=${verify.outcome ?? "unknown"})`,
      verifyOutcome: verify.outcome,
    };
  }

  return {
    ok: true,
    decision: "allow",
    verified: true,
    permitToken,
    evaluationId,
    proofHash,
    riskScore,
    verifyOutcome: verify.outcome ?? "verified",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRiskScore(result: Record<string, unknown>): string {
  const risk = result["risk"];
  if (risk && typeof risk === "object" && "score" in risk) {
    const score = (risk as { score?: unknown }).score;
    if (typeof score === "number") return String(score);
  }
  const flat = result["risk_score"];
  if (typeof flat === "number") return String(flat);
  return "";
}
