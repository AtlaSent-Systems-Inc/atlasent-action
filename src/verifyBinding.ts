// Shared verify-permit binding extraction for the batch and terminal-allow
// paths.
//
// The canonical single-evaluation path (src/index.ts runGate + the
// execution-boundary reverify) builds an EnforceConfig that carries
// environment / targetId / executionPayloadHash, so @atlasent/enforce's
// verifyPermit() re-binds them at /v1-verify-permit and a permit presented for a
// different artifact / environment / target fails closed (PAYLOAD_MISMATCH /
// ENVIRONMENT_MISMATCH / target mismatch).
//
// The batch (src/batch.ts) and terminal-allow (src/v21.ts) paths previously
// built the verify config with only { apiKey, apiUrl, action, actor } — so those
// shipped executable paths proved WEAKER substitution resistance than
// single-eval. This helper closes that gap: every executable verify path binds
// the same evaluated values the item carried into /v1-evaluate.
//
// Field spelling matches the runtime wire request the item was evaluated with:
// `environment` (top-level), `target_id` and `execution_payload_hash` (the item
// may carry these top-level or inside context — the runtime reads both). We do
// NOT accept camelCase variants: forwarding a differently-spelled value the
// runtime never bound would silently normalize the contract. We also do NOT
// recompute or canonicalize the payload hash — the exact evaluated value is
// forwarded verbatim.

import type { EvaluateRequest } from "./types";

/** The subset of @atlasent/enforce's EnforceConfig that verifyPermit re-binds. */
export interface VerifyBindingConfig {
  apiKey: string;
  apiUrl: string;
  action: string;
  actor: string;
  environment?: string;
  targetId?: string;
  executionPayloadHash?: string;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build the verify-permit config for one evaluated batch/terminal item, carrying
 * the evaluated environment / target / artifact-digest bindings so the verify
 * round-trip re-checks the caller is executing the SAME thing the permit was
 * issued for. Reads each binding from the item top-level first, then context,
 * using the canonical snake_case wire keys only.
 */
export function buildVerifyConfig(
  apiKey: string,
  apiUrl: string,
  item: EvaluateRequest,
): VerifyBindingConfig {
  const rec = item as unknown as Record<string, unknown>;
  const ctx = (item.context ?? {}) as Record<string, unknown>;
  // Top-level (rec[key], which includes item.environment) wins over context.
  // nonEmptyString treats "" as absent so an empty binding never masquerades as
  // a real one (nullish `??` would let "" through).
  const pick = (key: string): string | undefined =>
    nonEmptyString(rec[key]) ?? nonEmptyString(ctx[key]);

  return {
    apiKey,
    apiUrl,
    action: item.action,
    actor: item.actor,
    environment: pick("environment"),
    targetId: pick("target_id"),
    executionPayloadHash: pick("execution_payload_hash"),
  };
}
