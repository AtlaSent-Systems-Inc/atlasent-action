// Infrastructure error type for the v2.1 batch path.
//
// The single-eval path (src/index.ts) uses @atlasent/enforce as the canonical
// enforcement wrapper, including its verifyPermit() function. The batch path
// (src/batch.ts, src/v21.ts) also uses @atlasent/enforce's verifyPermit() as
// the canonical verify-permit implementation.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
