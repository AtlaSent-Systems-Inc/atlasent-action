// Wave B.AC4 preview — v2.1 entry point.
//
// Kept separate from src/index.ts so the existing v2.0 entry point
// stays byte-identical. B.AC4 wires this in once the new shape is
// reviewed.
//
// Flow:
//   1. parseInputs() detects single vs list shape.
//   2. evaluateMany() runs (single becomes a 1-item batch under the
//      hood, no separate code path).
//   3. If any decision is hold|escalate AND a wait-for-id is set,
//      waitForTerminalDecision() blocks until the upstream approver
//      flips it.
//   4. After terminal decisions are settled, the runtime evidence
//      emitter (B7) fires execution_started events for every allow+
//      verified decision. Best-effort, never blocks the action.
//   5. Job summary is rendered per evaluation.

import { verifyPermit } from "@atlasent/enforce";
import { evaluateMany } from "./batch";
import { parseInputs } from "./inputs";
import { waitForTerminalDecision } from "./stream";
import type { Decision, EvaluateRequest } from "./types";
import { emitEvidenceEvent } from "./evidenceClient";

export interface RunOutput {
  decisions: Decision[];
  failed: boolean;
  batchId: string;
}

/**
 * Fire execution_started events for every successful authorization in a
 * batch. Pure function over (decisions, items) so the wiring is testable
 * without the upstream mocks. Best-effort: every failure is swallowed
 * and the function never throws.
 *
 * Skipped: deny / hold / escalate, missing permitToken, missing
 * evaluation id, verified !== true.
 */
export async function emitBatchEvidence(
  decisions: Decision[],
  items: EvaluateRequest[],
  cfg: { apiKey: string; apiUrl: string },
  log: { info: (m: string) => void; warning: (m: string) => void } = console as unknown as {
    info: (m: string) => void;
    warning: (m: string) => void;
  },
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const item = items[i];
    if (!d || !item) continue;
    if (d.decision !== "allow") continue;
    if (d.verified !== true) continue;
    if (!d.permitToken || !d.id) continue;

    tasks.push(
      emitEvidenceEvent(
        cfg,
        {
          event_type: "execution_started",
          permit_token: d.permitToken,
          evaluation_id: d.id,
          environment: item.environment ?? "unknown",
          execution_started_at: new Date().toISOString(),
          metadata: {
            ...(item.context ?? {}),
            source: "github-action-batch",
            action: item.action,
            actor: item.actor,
          },
        },
        log,
      ).catch((err) => {
        // emitEvidenceEvent already swallows; this is belt-and-braces
        // so that an unexpected throw can't bubble out of allSettled.
        const msg = err instanceof Error ? err.message : String(err);
        log.warning(`AtlaSent: batch emit threw (advisory): ${msg}`);
      }),
    );
  }
  await Promise.allSettled(tasks);
}

export async function runV21(
  env: Record<string, string | undefined>,
  flags: { v2Batch: boolean; v2Streaming: boolean },
): Promise<RunOutput> {
  const inputs = parseInputs(env);
  const items = inputs.evaluations ?? [inputs.single!];

  const batch = await evaluateMany(
    inputs.apiUrl,
    inputs.apiKey,
    items,
    flags.v2Batch,
  );

  let decisions = batch.decisions;

  if (inputs.waitForId) {
    const idx = decisions.findIndex(
      (d) =>
        d.id === inputs.waitForId &&
        (d.decision === "hold" || d.decision === "escalate"),
    );
    if (idx >= 0) {
      const terminal = await waitForTerminalDecision({
        apiUrl: inputs.apiUrl,
        apiKey: inputs.apiKey,
        evaluationId: inputs.waitForId,
        timeoutMs: inputs.waitTimeoutMs ?? 600_000,
        v2Streaming: flags.v2Streaming,
      });
      decisions = [...decisions];
      if (terminal.decision === "allow") {
        // Terminal allow must be verified — same fail-closed contract as evaluateMany.
        // Uses @atlasent/enforce's canonical verifyPermit() implementation.
        const item = items[idx];
        const vr = terminal.permitToken
          ? await verifyPermit(
              { apiKey: inputs.apiKey, apiUrl: inputs.apiUrl, action: item.action, actor: item.actor },
              { decision: "allow" as const, permitToken: terminal.permitToken },
            )
          : { verified: false as const, outcome: undefined };
        decisions[idx] = { ...terminal, verified: vr.verified, verifyOutcome: vr.outcome };
      } else {
        decisions[idx] = terminal;
      }
    }
  }

  // ── B7: emit runtime evidence for every successful authorization ──────────
  // Runs only after the wait-for-id reconciliation, so terminal allows that
  // started life as hold/escalate are still emitted. Best-effort; failures
  // don't change the RunOutput.
  await emitBatchEvidence(decisions, items, {
    apiKey: inputs.apiKey,
    apiUrl: inputs.apiUrl,
  });

  const failed =
    inputs.failOnDeny &&
    decisions.some((d) => d.decision === "deny" || d.decision === "hold" || d.decision === "escalate");

  return { decisions, failed, batchId: batch.batchId };
}
