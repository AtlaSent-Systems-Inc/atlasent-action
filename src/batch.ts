// Wave B.AC2 / B.AC4 — batch fan-out helper with per-decision verify-permit.
//
// Runs a per-item /v1-evaluate loop, then verify-permit for every allow
// decision, matching the single-eval runGate() contract — the gate is
// fail-closed end-to-end.
//
// Uses @atlasent/enforce's verifyPermit() as the canonical implementation.
//
// NOTE (2026-09, #131): this module previously also supported an opt-in
// `/v1-evaluate/batch` server endpoint. That endpoint never existed on the
// runtime API (atlasent-api's `v1-evaluate` entry dispatcher only recognizes
// a `/close-ops` suffix — there is no `/batch` sub-route), so every real
// call with that opt-in enabled failed. The opt-in (`v2-batch` action input)
// was removed rather than fixed, since fixing it requires a server-side
// change in atlasent-api that is out of scope for this repo. The per-item
// loop below is unaffected and remains the only batch behavior.

import { verifyPermit, requiredBindingsFor } from "@atlasent/enforce";
import type { EvaluateRequest } from "./types";
import type { Decision } from "./types";

export interface BatchResult {
  decisions: Decision[];
  /** Originating batchId — always a `loop-<ts>` marker. */
  batchId: string;
}

export async function evaluateMany(
  apiUrl: string,
  apiKey: string,
  items: EvaluateRequest[],
): Promise<BatchResult> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  const { decisions, batchId } = await loopEvaluate(apiUrl, headers, items);

  // Verify permits for every allow decision using the canonical verifyPermit()
  // from @atlasent/enforce. Fail-closed: if any verify throws, the error
  // propagates up.
  const verified = await Promise.all(
    decisions.map(async (d, i) => {
      if (d.decision !== "allow" || !d.permitToken) {
        return { ...d, verified: d.decision === "allow" ? false : undefined };
      }
      const item = items[i];
      const runtimeExecutionHash =
        d.executionHashExpected ?? d.execution_hash_expected;
      // Re-bind the SAME environment / target / artifact digest this item was
      // evaluated with, and REQUIRE each at verify (fail-closed). Previously the
      // batch verify sent only {action,actor} — an unbound verify that a cross-item,
      // wrong-environment, or artifact-substituted permit could still satisfy.
      const enforceConfig = {
        apiKey,
        apiUrl,
        action: item.action,
        actor: item.actor,
        environment: item.environment,
        targetId: item.target_id,
        executionPayloadHash: runtimeExecutionHash ?? item.execution_payload_hash,
        requiredBindings: requiredBindingsFor({
          environment: item.environment,
          targetId: item.target_id,
          executionPayloadHash: runtimeExecutionHash ?? item.execution_payload_hash,
        }),
      };
      const enforceDecision = {
        decision: "allow" as const,
        permitToken: d.permitToken,
        executionHashExpected: runtimeExecutionHash,
      };
      const result = await verifyPermit(enforceConfig, enforceDecision);
      return { ...d, verified: result.verified, verifyOutcome: result.outcome };
    }),
  );

  return { decisions: verified, batchId };
}

/** Per-item /v1-evaluate loop — the only batch transport. */
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
