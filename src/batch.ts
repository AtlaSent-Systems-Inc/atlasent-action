// Wave B.AC2 / B.AC4 — batch fan-out helper with per-decision verify-permit.
//
// When the per-tenant `v2Batch` flag is on, posts a single batch to
// /v1/evaluate/batch. Otherwise, per-item /v1/evaluate loop. Either
// path then runs verify-permit for every allow decision, matching the
// single-eval runGate() contract — the gate is fail-closed end-to-end.

import { verifyOne } from "./gate";
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

  let decisions: Decision[];
  let batchId: string;

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
    decisions = data.results;
    batchId = data.batchId;
  } else {
    decisions = [];
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
    batchId = `loop-${Date.now()}`;
  }

  // Verify permits for every allow decision.
  // Uses the REST-style path (/v1/verify-permit) matching the v2 API convention.
  // Fail-closed: if any verify throws, the error propagates up.
  const verified = await Promise.all(
    decisions.map(async (d, i) => {
      if (d.decision !== "allow" || !d.permitToken) {
        return { ...d, verified: d.decision === "allow" ? false : undefined };
      }
      const item = items[i];
      const result = await verifyOne({
        apiUrl,
        apiKey,
        actionType: item.action,
        actorId: item.actor,
        permitToken: d.permitToken,
        verifyPath: "/v1/verify-permit",
      });
      return { ...d, verified: result.verified, verifyOutcome: result.outcome };
    }),
  );

  return { decisions: verified, batchId };
}
