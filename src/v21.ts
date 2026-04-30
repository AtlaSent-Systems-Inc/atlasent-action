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
//   4. Job summary is rendered per evaluation.

import { evaluateMany } from "./batch";
import { verifyOne } from "./gate";
import { parseInputs } from "./inputs";
import { waitForTerminalDecision } from "./stream";
import type { Decision } from "./types";

export interface RunOutput {
  decisions: Decision[];
  failed: boolean;
  batchId: string;
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
        const item = items[idx];
        const vr = terminal.permitToken
          ? await verifyOne({
              apiUrl: inputs.apiUrl,
              apiKey: inputs.apiKey,
              actionType: item.action,
              actorId: item.actor,
              permitToken: terminal.permitToken,
              verifyPath: "/v1/verify-permit",
            })
          : { verified: false as const, outcome: undefined };
        decisions[idx] = { ...terminal, verified: vr.verified, verifyOutcome: vr.outcome };
      } else {
        decisions[idx] = terminal;
      }
    }
  }

  const failed =
    inputs.failOnDeny && decisions.some((d) => d.decision === "deny");

  return { decisions, failed, batchId: batch.batchId };
}
