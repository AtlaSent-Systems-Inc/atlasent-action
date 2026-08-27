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

import { verifyPermit, requiredBindingsFor } from "@atlasent/enforce";
import { evaluateMany } from "./batch";
import { parseInputs } from "./inputs";
import { waitForTerminalDecision } from "./stream";
import type { Decision, EvaluateRequest } from "./types";
import { emitEvidenceEvent } from "./evidenceClient";
import { PRODUCTION_DEPLOY_ACTION } from "./canonicalAction";
import {
  WorkloadIdentityError,
  mintGithubActionsActorIdentity,
  type MintedGithubActionsIdentity,
} from "./workloadIdentity";

export interface RunOutput {
  decisions: Decision[];
  failed: boolean;
  batchId: string;
}

interface RunV21Deps {
  mintWorkloadIdentity?: typeof mintGithubActionsActorIdentity;
  mask?: (value: string) => void;
}

/**
 * Replace every production.deploy batch actor with a separately minted,
 * runtime-verified GitHub workload identity. A distinct mint per item keeps
 * the source OIDC credential and the resulting assertion single-use. Caller
 * supplied actor_identity fields are stripped from every item.
 */
async function bindBatchWorkloadIdentities(
  items: EvaluateRequest[],
  cfg: { apiKey: string; apiUrl: string },
  deps: RunV21Deps,
): Promise<EvaluateRequest[]> {
  const mint = deps.mintWorkloadIdentity ?? mintGithubActionsActorIdentity;
  const bound: EvaluateRequest[] = [];

  for (const item of items) {
    const sanitized = { ...item };
    delete sanitized.actor_identity;

    if (item.action !== PRODUCTION_DEPLOY_ACTION) {
      bound.push(sanitized);
      continue;
    }

    const environment = item.environment?.trim();
    if (!environment) {
      throw new WorkloadIdentityError(
        "Every production.deploy batch evaluation requires its own non-empty `environment` binding",
      );
    }

    const identity: MintedGithubActionsIdentity = await mint(
      {
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        actionType: item.action,
        environment,
      },
      { mask: deps.mask },
    );

    // Mandatory production-change controls reject a caller-supplied raw
    // execution_payload_hash. Treat it as the artifact identity inside the
    // structured plan and bind the plan to the broker-verified GitHub SHA.
    const artifactRef = sanitized.execution_payload_hash;
    delete sanitized.execution_payload_hash;

    bound.push({
      ...sanitized,
      actor: identity.actorId,
      environment,
      actor_identity: identity.assertion,
      change_plan: {
        operation: "deploy",
        revision: identity.source.sha,
        ...(artifactRef ? { artifact_ref: artifactRef } : {}),
      },
      context: {
        ...(item.context ?? {}),
        triggering_actor: `github:${identity.source.actor}`,
      },
    });
  }

  return bound;
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
  deps: RunV21Deps = {},
): Promise<RunOutput> {
  const inputs = parseInputs(env);
  const parsedItems = inputs.evaluations ?? [inputs.single!];
  const items = inputs.evaluations
    ? await bindBatchWorkloadIdentities(
        parsedItems,
        { apiKey: inputs.apiKey, apiUrl: inputs.apiUrl },
        deps,
      )
    : parsedItems;

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
      // The approval-status endpoint returns the fresh permit but does not
      // repeat the execution hash derived during the original evaluation.
      // Preserve that immutable binding across hold/escalate → allow so the
      // fresh permit is still verified against the exact approved plan.
      const originalExecutionHash =
        decisions[idx].executionHashExpected ??
        decisions[idx].execution_hash_expected;
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
        const runtimeExecutionHash =
          terminal.executionHashExpected ??
          terminal.execution_hash_expected ??
          originalExecutionHash;
        const vr = terminal.permitToken
          ? await verifyPermit(
              {
                apiKey: inputs.apiKey,
                apiUrl: inputs.apiUrl,
                action: item.action,
                actor: item.actor,
                // Bind + require the same environment / target / digest the item was
                // evaluated with. A terminal allow (hold→allow) is verified under the
                // SAME bindings as the direct-allow path — not an unbound verify.
                environment: item.environment,
                targetId: item.target_id,
                executionPayloadHash: runtimeExecutionHash ?? item.execution_payload_hash,
                requiredBindings: requiredBindingsFor({
                  environment: item.environment,
                  targetId: item.target_id,
                  executionPayloadHash: runtimeExecutionHash ?? item.execution_payload_hash,
                }),
              },
              {
                decision: "allow" as const,
                permitToken: terminal.permitToken,
                executionHashExpected: runtimeExecutionHash,
              },
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

  const failed = decisions.some(
    (d) => d.decision === "deny" || d.decision === "hold" || d.decision === "escalate",
  );

  return { decisions, failed, batchId: batch.batchId };
}
