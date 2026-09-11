// @atlasent/azure-devops-task — core gate logic.
//
// Platform-agnostic apart from the small TaskLogger interface below, so it
// can be unit-tested without azure-pipelines-task-lib and without a real
// Azure Pipelines agent. The AtlaSentGate task entrypoint
// (AtlaSentGate/dist/index.js, built from src/index.ts) is a thin adapter
// that reads Azure Pipelines task inputs/variables, calls parseInputs() +
// runGate() here, and reports the result via azure-pipelines-task-lib.
//
// Mirrors atlasent-action's own single-eval GitHub Action path (src/index.ts
// in this repo) against Azure Pipelines instead of @actions/core: evaluate
// -> verify -> verify-permit (+ optional pause-and-resume), fail-closed on
// anything but decision=allow AND a verified, unreplayed permit.
//
// Deliberately narrower scope than the GitHub Action for this first slice:
// no GitHub-OIDC-style verified-workload-actor minting, no mandatory
// change-plan derivation, no approval-artifact minting, no
// batch/policy-sync/release-mode/governance-agents/change-brief/posture-scan
// modes. Single-eval only. See packages/azure-devops-task/README.md.

import {
  evaluate,
  verify,
  verifyPermit,
  reverifyPermit,
  requiredBindingsFor,
  waitForApprovalResolution,
  EnforceError,
  type Decision,
  type EnforceConfig,
} from "@atlasent/enforce";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface TaskLogger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

/** A logger that discards everything — useful as a test default. */
export const nullLogger: TaskLogger = {
  debug: () => {},
  info: () => {},
  warning: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export type ApprovalsFrom = "pr-reviews" | "none";
export type GateMode = "enforce" | "evaluate-only";

export interface GateInputs {
  apiKey: string;
  apiUrl?: string;
  action: string;
  actor: string;
  targetId?: string;
  environment: string;
  context: Record<string, unknown>;
  approvalsFrom: ApprovalsFrom;
  waitForApproval: boolean;
  maxWaitMinutes: number;
  /**
   * "enforce" (default): evaluate -> verify -> verify-permit in one task
   * invocation, consuming the single-use permit here. "evaluate-only":
   * evaluate -> verify only — ISSUES a permit without consuming it, for a
   * later task invocation (verifyPermitOnly: true, same action/actor/
   * targetId/environment) to re-verify and consume immediately before the
   * protected step actually runs — the execution-boundary pattern. Ignored
   * when verifyPermitOnly is true.
   */
  mode: GateMode;
  /**
   * When true, this task invocation does NOT call evaluate() at all — it
   * re-verifies (and consumes) an already-issued permit token immediately
   * before a protected step, independent of the task invocation that issued
   * it. Requires permitToken. See reverifyPermit() in @atlasent/enforce.
   */
  verifyPermitOnly: boolean;
  /** Required when verifyPermitOnly is true: the permit token from an
   *  earlier mode: evaluate-only task invocation. */
  permitToken?: string;
}

/**
 * Raw, unvalidated strings as read from the Azure Pipelines environment —
 * task inputs (tl.getInput) and predefined variables (tl.getVariable) are
 * both just strings (or undefined), so this is the seam parseInputs()
 * validates and defaults from. Kept separate from the ADO SDK itself so
 * tests can supply plain objects.
 */
export interface RawGateEnv {
  /** ATLASENT_API_KEY — read from the environment, same convention as the
   *  GitHub Action (a secret, never a plain task input). */
  apiKey: string | undefined;
  /** ATLASENT_BASE_URL, or the optional `apiUrl` task input override. */
  apiUrl: string | undefined;
  action: string | undefined;
  actor: string | undefined;
  targetId: string | undefined;
  environment: string | undefined;
  contextRaw: string | undefined;
  approvalsFromRaw: string | undefined;
  waitForApprovalRaw: string | undefined;
  maxWaitMinutesRaw: string | undefined;
  /** "enforce" (default) | "evaluate-only". */
  modeRaw: string | undefined;
  /** "true" to run in verify-permit-only (execution-boundary) mode. */
  verifyPermitRaw: string | undefined;
  /** The permit token to re-verify — required when verifyPermitRaw is "true". */
  permitTokenRaw: string | undefined;
  /** Build.RequestedFor — classic/YAML pipeline predefined variable. */
  buildRequestedFor: string | undefined;
  /** Release.RequestedFor — classic release pipeline predefined variable. */
  releaseRequestedFor: string | undefined;
  /** Build.SourceBranch — used for the same "main => live" auto-environment
   *  heuristic atlasent-action's GitHub Action applies to `github.ref`. */
  sourceBranch: string | undefined;
}

export class GateInputError extends Error {}

/**
 * Resolve `environment` the same way atlasent-action's GitHub Action does
 * (src/index.ts's resolveEnvironment): an explicit value always wins;
 * otherwise infer from the API key's test/live prefix; otherwise infer from
 * the source branch (main/master => live, anything else => test).
 *
 * Mirrored here rather than imported — this package has no dependency on the
 * GitHub Action's own src/ (that is application code for a different task
 * runtime, not a published library). Keep in sync by hand; a mismatch only
 * changes the DEFAULT this task guesses when `environment` is omitted, never
 * what the runtime itself enforces.
 */
export function resolveEnvironment(
  explicit: string | undefined,
  apiKey: string,
  sourceBranch: string | undefined,
): string {
  const trimmed = (explicit ?? "").trim();
  if (trimmed) return trimmed;
  if (apiKey.startsWith("ask_test_")) return "test";
  if (apiKey.startsWith("ask_live_")) return "live";
  const branch = (sourceBranch ?? "").replace(/^refs\/heads\//, "");
  return branch === "main" || branch === "master" ? "live" : "test";
}

export function parseInputs(env: RawGateEnv): GateInputs {
  const apiKey = (env.apiKey ?? "").trim();
  if (!apiKey) {
    throw new GateInputError(
      "Missing required environment variable: ATLASENT_API_KEY. Set it as a secret " +
        "pipeline variable and map it into this task's environment, e.g. " +
        "`env: { ATLASENT_API_KEY: $(AtlasentApiKey) }` on the task step.",
    );
  }

  const action = (env.action ?? "").trim();
  if (!action) {
    throw new GateInputError("Missing required input: action");
  }

  const actor =
    (env.actor ?? "").trim() ||
    (env.buildRequestedFor ?? "").trim() ||
    (env.releaseRequestedFor ?? "").trim() ||
    "unknown";

  const environment = resolveEnvironment(env.environment, apiKey, env.sourceBranch);

  let context: Record<string, unknown> = {};
  const contextRaw = (env.contextRaw ?? "").trim();
  if (contextRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contextRaw);
    } catch {
      throw new GateInputError("`context` input is not valid JSON — expected a JSON object");
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GateInputError("`context` input must be a JSON object");
    }
    context = parsed as Record<string, unknown>;
  }

  const approvalsFromRaw = (env.approvalsFromRaw ?? "none").trim().toLowerCase();
  const approvalsFrom: ApprovalsFrom = approvalsFromRaw === "pr-reviews" ? "pr-reviews" : "none";

  const waitForApproval = (env.waitForApprovalRaw ?? "false").trim().toLowerCase() === "true";

  const maxWaitMinutesParsed = parseInt((env.maxWaitMinutesRaw ?? "30").trim(), 10);
  const maxWaitMinutes =
    Number.isFinite(maxWaitMinutesParsed) && maxWaitMinutesParsed > 0 ? maxWaitMinutesParsed : 30;

  const mode: GateMode = (env.modeRaw ?? "").trim().toLowerCase() === "evaluate-only" ? "evaluate-only" : "enforce";

  const verifyPermitOnly = (env.verifyPermitRaw ?? "false").trim().toLowerCase() === "true";
  const permitToken = (env.permitTokenRaw ?? "").trim() || undefined;
  if (verifyPermitOnly && !permitToken) {
    throw new GateInputError(
      "Missing required input: permitToken (required when verifyPermit is 'true' — pass the " +
        "permitToken output from an earlier mode: evaluate-only task invocation).",
    );
  }

  return {
    apiKey,
    apiUrl: (env.apiUrl ?? "").trim() || undefined,
    action,
    actor,
    targetId: (env.targetId ?? "").trim() || undefined,
    environment,
    context,
    approvalsFrom,
    waitForApproval,
    maxWaitMinutes,
    mode,
    verifyPermitOnly,
    permitToken,
  };
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Stringly-typed to match Azure Pipelines' own variable convention — every
 *  task/pipeline variable is a string, same posture the GitHub Action takes
 *  with core.setOutput(). */
export interface GateOutputs {
  decision: string;
  verified: string; // "true" | "false"
  permitToken: string;
  proofHash: string;
  riskScore: string;
  evaluationId: string;
  waitedForApproval: string; // "true" | "false"
}

export function emptyOutputs(): GateOutputs {
  return {
    decision: "",
    verified: "false",
    permitToken: "",
    proofHash: "",
    riskScore: "",
    evaluationId: "",
    waitedForApproval: "false",
  };
}

function decisionOutputs(d: Decision, waitedForApproval: boolean): GateOutputs {
  return {
    decision: d.decision,
    verified: "false",
    permitToken: d.permitToken ?? "",
    proofHash: d.proofHash ?? "",
    riskScore: d.riskScore != null ? String(d.riskScore) : "",
    evaluationId: d.evaluationId ?? "",
    waitedForApproval: waitedForApproval ? "true" : "false",
  };
}

export interface GateResult {
  /** true only when decision=allow AND the permit was verified. Gate on
   *  this — same "verified, not decision" rule as the GitHub Action. */
  ok: boolean;
  message: string;
  outputs: GateOutputs;
}

function describeError(err: unknown): string {
  if (err instanceof EnforceError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// The gate itself: evaluate -> (optional wait-for-approval) -> verify -> verify-permit
// ---------------------------------------------------------------------------

export async function runGate(inputs: GateInputs, log: TaskLogger): Promise<GateResult> {
  const config: EnforceConfig = {
    apiKey: inputs.apiKey,
    apiUrl: inputs.apiUrl,
    action: inputs.action,
    actor: inputs.actor,
    targetId: inputs.targetId,
    environment: inputs.environment,
    context: inputs.context,
    // Re-present every binding provided here at verify, or fail closed
    // (MISSING_BINDING) rather than silently drop it — same contract the
    // GitHub Action's single-eval path uses.
    requiredBindings: requiredBindingsFor({
      environment: inputs.environment,
      targetId: inputs.targetId,
    }),
  };

  // ── Execution-boundary mode: verify (and consume) an already-issued
  // permit from an earlier `mode: evaluate-only` task invocation. No
  // evaluate() call at all — see reverifyPermit()'s own doc comment in
  // @atlasent/enforce. ────────────────────────────────────────────────────
  if (inputs.verifyPermitOnly) {
    const permitToken = inputs.permitToken as string; // guaranteed by parseInputs
    log.info(
      `AtlaSent Gate: re-verifying permit at the execution boundary for "${inputs.action}" ` +
        `(actor=${inputs.actor}, environment=${inputs.environment}` +
        (inputs.targetId ? `, target=${inputs.targetId}` : "") + ").",
    );
    try {
      const r = await reverifyPermit(config, permitToken);
      log.info(
        `AtlaSent Gate: permit re-verified at the execution boundary` +
          (r.outcome ? ` (outcome=${r.outcome})` : "") + ". Proceeding.",
      );
      return {
        ok: true,
        message: "AtlaSent Gate: permit re-verified at the execution boundary.",
        outputs: {
          decision: "allow",
          verified: "true",
          permitToken,
          proofHash: "",
          riskScore: "",
          evaluationId: "",
          waitedForApproval: "false",
        },
      };
    } catch (err) {
      return {
        ok: false,
        message: `AtlaSent Gate: ${describeError(err)}. Deploy blocked at execution boundary (fail-closed).`,
        outputs: {
          decision: "deny",
          verified: "false",
          permitToken,
          proofHash: "",
          riskScore: "",
          evaluationId: "",
          waitedForApproval: "false",
        },
      };
    }
  }

  if (inputs.approvalsFrom === "pr-reviews") {
    log.warning(
      "approvalsFrom: pr-reviews is not implemented for Azure DevOps Pipelines in this v1 task " +
        "— no approval count is auto-derived from Azure Repos pull request reviews. Pass " +
        "context.approvals explicitly (e.g. from an Azure Repos PR API call in an earlier step) " +
        "if your policy requires one. Proceeding as approvalsFrom: none.",
    );
  }

  // ── Step 1: evaluate ────────────────────────────────────────────────────
  let decision: Decision;
  try {
    decision = await evaluate(config);
  } catch (err) {
    return {
      ok: false,
      message: `AtlaSent Gate: ${describeError(err)}. Deploy blocked (fail-closed).`,
      outputs: emptyOutputs(),
    };
  }

  log.info(
    `AtlaSent Gate: evaluating "${inputs.action}" for actor "${inputs.actor}" in ` +
      `${inputs.environment} environment` + (inputs.targetId ? ` (target=${inputs.targetId})` : "") +
      ` -> decision=${decision.decision}` +
      (decision.evaluationId ? ` (evaluation_id=${decision.evaluationId})` : ""),
  );

  // ── Step 1b: optional pause-and-resume for hold/escalate ───────────────
  // Off unless the caller opts in AND the decision actually carries an
  // approval_request_id to poll — otherwise fall straight through to
  // verify() below, which reports the ordinary hold/escalate denial.
  let waitedForApproval = false;
  if (
    inputs.mode === "enforce" &&
    inputs.waitForApproval &&
    (decision.decision === "hold" || decision.decision === "escalate") &&
    decision.approvalRequestId
  ) {
    waitedForApproval = true;
    log.info(
      `AtlaSent Gate: authorization ${decision.decision.toUpperCase()} — waiting up to ` +
        `${inputs.maxWaitMinutes}m for a human decision (approval_request_id=${decision.approvalRequestId}).`,
    );

    let resolution: Awaited<ReturnType<typeof waitForApprovalResolution>>;
    try {
      resolution = await waitForApprovalResolution({
        apiKey: inputs.apiKey,
        apiUrl: inputs.apiUrl,
        approvalId: decision.approvalRequestId,
        maxWaitMs: inputs.maxWaitMinutes * 60_000,
      });
    } catch (err) {
      return {
        ok: false,
        message: `AtlaSent Gate: ${describeError(err)}. Deploy blocked (fail-closed).`,
        outputs: decisionOutputs(decision, waitedForApproval),
      };
    }

    if (resolution.status !== "approved" || !resolution.permitToken) {
      const reason =
        `human approval resolved to '${resolution.status}'` +
        (resolution.reEvaluationDecision
          ? ` (fresh reevaluation: ${resolution.reEvaluationDecision})`
          : "") +
        " — deploy blocked (fail-closed).";
      return {
        ok: false,
        message: `AtlaSent Gate: Authorization DENIED: ${reason}`,
        outputs: decisionOutputs({ ...decision, decision: "deny", denyReason: reason }, waitedForApproval),
      };
    }

    // Approved with a fresh permit — re-verify it below (same bindings as
    // the original evaluate) before treating this as allow. "approved"
    // alone never authorizes the deploy; only a verified permit does.
    decision = { ...decision, decision: "allow", permitToken: resolution.permitToken };
  }

  // ── Step 2: verify (decision check — no HTTP call) ─────────────────────
  try {
    verify(decision);
  } catch (err) {
    return {
      ok: false,
      message: `AtlaSent Gate: ${describeError(err)}. Deploy blocked (fail-closed).`,
      outputs: decisionOutputs(decision, waitedForApproval),
    };
  }

  // ── evaluate-only (issue-permit) success ────────────────────────────────
  // A permit was ISSUED but deliberately NOT verified/consumed. `verified`
  // is honestly "false" — the caller MUST re-verify at the execution
  // boundary (a later task invocation with verifyPermitOnly: true) and gate
  // the protected step on THAT invocation's result, not this one.
  if (inputs.mode === "evaluate-only") {
    const outputs = decisionOutputs(decision, waitedForApproval);
    log.info(
      "AtlaSent Gate: permit issued (not yet verified/consumed) — re-verify it at the " +
        "execution boundary with verifyPermit: true before the protected step runs.",
    );
    return { ok: true, message: "AtlaSent Gate: permit issued (evaluate-only mode).", outputs };
  }

  // ── Step 3: verify-permit (consumes the single-use permit) ─────────────
  let verifyOutcome: string | undefined;
  try {
    const vp = await verifyPermit(config, decision);
    verifyOutcome = vp.outcome;
  } catch (err) {
    return {
      ok: false,
      message: `AtlaSent Gate: ${describeError(err)}. Deploy blocked (fail-closed).`,
      outputs: decisionOutputs(decision, waitedForApproval),
    };
  }

  const outputs = decisionOutputs(decision, waitedForApproval);
  outputs.verified = "true";
  log.info(
    `AtlaSent Gate: allowed and verified` + (verifyOutcome ? ` (outcome=${verifyOutcome})` : "") + ".",
  );
  return { ok: true, message: "AtlaSent Gate: allowed and verified.", outputs };
}
