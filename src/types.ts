// Shared types for the v2.1 modules. Kept separate from the v2.0
// entry point in src/index.ts so that file remains untouched until
// B.AC4 wires the new modules in.

export interface EvaluateRequest {
  action: string;
  actor: string;
  environment?: string;
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
}
