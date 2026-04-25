// Wave B.AC2 — batch fan-out helper.
//
// When the per-tenant `v2_batch` flag is on, posts a single batch to
// /v1/evaluate/batch. Otherwise, per-item /v1/evaluate loop. Either
// path returns the same `BatchResult` shape so the action's render
// step does not branch on transport.

import type { Decision, EvaluateRequest } from "./types";

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
  if (v2Batch) {
    const r = await fetch(`${apiUrl}/v1/evaluate/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items }),
    });
    if (!r.ok) {
      throw new Error(`atlasent /v1/evaluate/batch ${r.status}`);
    }
    const data = (await r.json()) as {
      results: Decision[];
      batchId: string;
    };
    return { decisions: data.results, batchId: data.batchId };
  }
  const decisions: Decision[] = [];
  for (const item of items) {
    const r = await fetch(`${apiUrl}/v1/evaluate`, {
      method: "POST",
      headers,
      body: JSON.stringify(item),
    });
    if (!r.ok) {
      throw new Error(`atlasent /v1/evaluate ${r.status}`);
    }
    decisions.push((await r.json()) as Decision);
  }
  return { decisions, batchId: `loop-${Date.now()}` };
}
