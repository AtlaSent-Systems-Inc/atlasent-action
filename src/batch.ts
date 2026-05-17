// Wave B.AC2 / B.AC4 — batch fan-out helper with per-decision verify-permit.
//
// When the per-tenant `v2Batch` flag is on, posts a single batch to
// /v1-evaluate/batch. Otherwise, per-item /v1-evaluate loop. Either
// path then runs verify-permit for every allow decision, matching the
// single-eval runGate() contract — the gate is fail-closed end-to-end.
//
// Uses @atlasent/enforce's verifyPermit() as the canonical implementation.
//
// Wave B hardening (V2-D3 contract alignment):
//   • items < 2 → skip batch entirely, use per-item loop (no benefit).
//   • items > 100 → chunk into ≤100-item batches (server hard-cap).
//   • 404 from /v1-evaluate/batch → automatic fallback to per-item loop
//     (v2_batch tenant flag is off; closed-by-default behavior).

import { verifyPermit } from "@atlasent/enforce";
import type { EvaluateRequest } from "./types";
import type { Decision } from "./types";

/**
 * Server-enforced cap from V2-D3: `/v1-evaluate/batch` rejects requests
 * with more than 100 items via `413 batch_too_large`. Mirror it here so
 * we chunk client-side rather than discovering the limit at runtime.
 */
export const BATCH_MAX_ITEMS = 100;

/**
 * Below this threshold, the batch endpoint provides no benefit (it adds
 * a round-trip and a server-side fan-out for nothing) so we short-circuit
 * straight to the per-item /v1-evaluate path.
 */
export const BATCH_MIN_ITEMS = 2;

export interface BatchResult {
  decisions: Decision[];
  /** Originating batchId, or `loop-<ts>` when the loop fallback ran. */
  batchId: string;
}

export async function evaluateMany(
  apiUrl: string,
  apiKey: string,
  items: EvaluateRequest[],
  v2Batch: boolean,
): Promise<BatchResult> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  let decisions: Decision[];
  let batchId: string;

  // Short-circuit: a "batch" of 0 or 1 items has no fan-out advantage
  // over the single-item endpoint, and skipping the batch hop also
  // avoids the v2_batch tenant-flag 404 round-trip for single-item
  // callers using the runV21 wrapper.
  const shouldUseBatch = v2Batch && items.length >= BATCH_MIN_ITEMS;

  if (shouldUseBatch) {
    try {
      const out = await postBatchChunked(apiUrl, headers, items);
      decisions = out.decisions;
      batchId = out.batchId;
    } catch (err) {
      // 404 from /v1-evaluate/batch means the tenant doesn't have the
      // `v2_batch` flag flipped on yet (V2-D3 closed-by-default). Fall
      // back to the per-item /v1-evaluate loop so the workflow still
      // succeeds — the per-item path is fail-closed in the same way.
      if (err instanceof BatchEndpointDisabled) {
        const out = await loopEvaluate(apiUrl, headers, items);
        decisions = out.decisions;
        batchId = out.batchId;
      } else {
        throw err;
      }
    }
  } else {
    const out = await loopEvaluate(apiUrl, headers, items);
    decisions = out.decisions;
    batchId = out.batchId;
  }

  // Verify permits for every allow decision using the canonical verifyPermit()
  // from @atlasent/enforce. Fail-closed: if any verify throws, the error
  // propagates up.
  const verified = await Promise.all(
    decisions.map(async (d, i) => {
      if (d.decision !== "allow" || !d.permitToken) {
        return { ...d, verified: d.decision === "allow" ? false : undefined };
      }
      const item = items[i];
      const enforceConfig = { apiKey, apiUrl, action: item.action, actor: item.actor };
      const enforceDecision = { decision: "allow" as const, permitToken: d.permitToken };
      const result = await verifyPermit(enforceConfig, enforceDecision);
      return { ...d, verified: result.verified, verifyOutcome: result.outcome };
    }),
  );

  return { decisions: verified, batchId };
}

/** Marker error: batch endpoint returned 404 → fall back to per-item loop. */
class BatchEndpointDisabled extends Error {
  constructor() {
    super("v1-evaluate/batch disabled for this tenant (404)");
    this.name = "BatchEndpointDisabled";
  }
}

/**
 * POST one or more batches to /v1-evaluate/batch, chunked to
 * BATCH_MAX_ITEMS. Decisions are concatenated in input order. The
 * returned batchId is the first chunk's batchId (or a synthetic
 * `chunked-<ts>` when there are multiple chunks, so downstream
 * audit references aren't misleadingly pinned to chunk 0).
 *
 * Throws `BatchEndpointDisabled` on the FIRST 404 so the caller can
 * fall back to the per-item loop without partial state. Any other
 * non-2xx throws a generic Error.
 */
async function postBatchChunked(
  apiUrl: string,
  headers: Record<string, string>,
  items: EvaluateRequest[],
): Promise<BatchResult> {
  const chunks: EvaluateRequest[][] = [];
  for (let i = 0; i < items.length; i += BATCH_MAX_ITEMS) {
    chunks.push(items.slice(i, i + BATCH_MAX_ITEMS));
  }

  const all: Decision[] = [];
  let firstBatchId = "";

  for (let c = 0; c < chunks.length; c++) {
    const r = await fetch(`${apiUrl}/v1-evaluate/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: chunks[c] }),
    });
    if (r.status === 404) {
      throw new BatchEndpointDisabled();
    }
    if (!r.ok) {
      throw new Error(`atlasent /v1-evaluate/batch ${r.status}`);
    }
    const data = (await r.json()) as { results: Decision[]; batchId: string };
    all.push(...data.results);
    if (c === 0) firstBatchId = data.batchId;
  }

  const batchId = chunks.length > 1 ? `chunked-${Date.now()}` : firstBatchId;
  return { decisions: all, batchId };
}

/**
 * Per-item /v1-evaluate loop. Used when:
 *   • v2Batch=false (caller didn't opt in), or
 *   • items.length < BATCH_MIN_ITEMS (no batch benefit), or
 *   • /v1-evaluate/batch returned 404 (v2_batch tenant flag off).
 */
async function loopEvaluate(
  apiUrl: string,
  headers: Record<string, string>,
  items: EvaluateRequest[],
): Promise<BatchResult> {
  const decisions: Decision[] = [];
  for (const item of items) {
    const r = await fetch(`${apiUrl}/v1-evaluate`, {
      method: "POST",
      headers,
      body: JSON.stringify(item),
    });
    if (!r.ok) {
      throw new Error(`atlasent /v1-evaluate ${r.status}`);
    }
    decisions.push((await r.json()) as Decision);
  }
  return { decisions, batchId: `loop-${Date.now()}` };
}
