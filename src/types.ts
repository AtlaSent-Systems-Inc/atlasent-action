// Shared types for the v2.1 modules. Kept separate from the v2.0
// entry point in src/index.ts so that file remains untouched until
// B.AC4 wires the new modules in.

export interface EvaluateRequest {
  action: string;
  actor: string;
  environment?: string;
  /** Target resource id — bound at evaluate and re-presented at verify (wire: `target_id`). */
  target_id?: string;
  /**
   * SHA-256 artifact digest — bound into the permit at evaluate (`execution_hash_expected`)
   * and re-presented at verify as `payload_hash`. A per-item permit issued for one artifact
   * then presented for another fails `PAYLOAD_MISMATCH`. Passed through to the evaluate wire.
   */
  execution_payload_hash?: string;
  context?: Record<string, unknown>;
}

export interface Decision {
  /** Evaluation id (for streaming-wait + audit). */
  id?: string;
  decision: "allow" | "deny" | "hold" | "escalate";
  permitToken?: string;
  proofHash?: string;
  reasons?: string[];
  evaluatedAt: string;
  /** Set after verify-permit round-trip. True only when evaluate=allow AND verify=true. */
  verified?: boolean;
  verifyOutcome?: string;
}
