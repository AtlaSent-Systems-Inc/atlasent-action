// verify-permit helper for the v2.1 batch path.
//
// The single-eval path (src/index.ts) uses @atlasent/enforce as the canonical
// enforcement wrapper. This module only exports verifyOne(), which is called
// per-decision after evaluateMany() in src/batch.ts.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifyParams {
  apiUrl: string;
  apiKey: string;
  actionType: string;
  actorId: string;
  permitToken: string;
  /** Override the verify endpoint path. Defaults to /v1-verify-permit
   *  (Supabase style). Pass "/v1/verify-permit" for the REST API. */
  verifyPath?: string;
}

export interface VerifyResult {
  verified: boolean;
  outcome?: string;
}

// Thrown for infrastructure failures (network, !2xx, non-JSON).
// Distinct from a policy decision so callers always fail-closed on these.
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
// verifyOne — single verify-permit round-trip
// ---------------------------------------------------------------------------

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
