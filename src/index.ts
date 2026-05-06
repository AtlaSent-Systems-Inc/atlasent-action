// AtlaSent Gate Action — GitHub Actions entry point.
//
// Routing:
//   evaluations input set → v2.1 batch path via runV21()
//   single action input   → @atlasent/enforce (canonical enforcement wrapper)
//
// The enforcement contract (evaluate → verify → verifyPermit) lives entirely
// in @atlasent/enforce. This file handles GH Actions I/O: reading inputs,
// masking secrets, and translating EnforceResult / EnforceError into step
// outputs and exit codes.

import { enforce, EnforceError } from "@atlasent/enforce";
import type { Decision, EnforceConfig } from "@atlasent/enforce";
import { GateInfraError } from "./gate";
import { runV21 } from "./v21";
import {
  assessFinancialGovernance,
} from "./financialGovernanceAdvisory";
import type { FinancialAdvisoryInput } from "./financialGovernanceAdvisory";

// ---------------------------------------------------------------------------
// GitHub Actions helpers
// ---------------------------------------------------------------------------

function getInput(name: string, required = false): string {
  const envKey = `INPUT_${name.replace(/-/g, "_").toUpperCase()}`;
  const val = (process.env[envKey] ?? "").trim();
  if (required && !val) {
    setFailed(`Input required and not supplied: ${name}`);
  }
  return val;
}

function setOutput(name: string, value: string): void {
  const outputFile = process.env["GITHUB_OUTPUT"];
  if (outputFile) {
    const fs = require("node:fs");
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
  console.log(`::set-output name=${name}::${value}`);
}

function setFailed(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

function warning(message: string): void {
  console.log(`::warning::${message}`);
}

function info(message: string): void {
  console.log(message);
}

function maskValue(value: string): void {
  console.log(`::add-mask::${value}`);
}

// ---------------------------------------------------------------------------
// GitHub context
// ---------------------------------------------------------------------------

interface GitHubContext {
  repository: string;
  ref: string;
  sha: string;
  run_id: string;
  run_number: string;
  workflow: string;
  event_name: string;
  pr_number: string | undefined;
  server_url: string;
}

function getGitHubContext(): GitHubContext {
  return {
    repository: process.env["GITHUB_REPOSITORY"] ?? "",
    ref: process.env["GITHUB_REF"] ?? "",
    sha: process.env["GITHUB_SHA"] ?? "",
    run_id: process.env["GITHUB_RUN_ID"] ?? "",
    run_number: process.env["GITHUB_RUN_NUMBER"] ?? "",
    workflow: process.env["GITHUB_WORKFLOW"] ?? "",
    event_name: process.env["GITHUB_EVENT_NAME"] ?? "",
    pr_number: process.env["GITHUB_REF"]?.match(/^\/refs\/pull\/(\d+)\//)?.[1],
    server_url: process.env["GITHUB_SERVER_URL"] ?? "https://github.com",
  };
}

function resolveEnvironment(explicit: string, ref: string, apiKey: string): string {
  if (explicit) return explicit;
  if (apiKey.startsWith("ask_test_")) return "test";
  if (apiKey.startsWith("ask_live_")) return "live";
  const branch = ref.replace("refs/heads/", "");
  return branch === "main" || branch === "master" ? "live" : "test";
}

// ---------------------------------------------------------------------------
// Output helpers — translate a Decision object into GH Actions outputs.
// Must be called BEFORE setFailed/warning so outputs are visible on failure.
// ---------------------------------------------------------------------------

function setDecisionOutputs(d: Decision): void {
  if (d.permitToken) maskValue(d.permitToken);
  if (d.proofHash) maskValue(d.proofHash);
  setOutput("decision", d.decision);
  setOutput("permit-token", d.permitToken ?? "");
  setOutput("evaluation-id", d.evaluationId ?? "");
  setOutput("proof-hash", d.proofHash ?? "");
  setOutput("risk-score", d.riskScore !== undefined ? String(d.riskScore) : "");
}

// ---------------------------------------------------------------------------
// Financial Governance Advisory — non-blocking, advisory only.
//
// Called after enforcement resolves (allow or deny). Never throws, never
// affects the exit code or enforcement decision.
// ---------------------------------------------------------------------------

function appendToStepSummary(content: string): void {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) {
    try {
      const fs = require("node:fs");
      fs.appendFileSync(summaryFile, content);
    } catch {
      // Non-fatal: advisory only
    }
  }
}

function emitFinancialGovernanceAdvisory(
  actionType: string,
  actor: string,
  orgId: string,
): void {
  const governanceMode = getInput("financial-governance");
  if (governanceMode !== "advisory") return;

  const rawValue = getInput("financial-action-value");
  const currency = getInput("financial-action-currency") || "USD";

  const actionValue = rawValue ? parseFloat(rawValue) : null;

  const advisoryInput: FinancialAdvisoryInput = {
    actionType,
    actionValue: actionValue !== null && !isNaN(actionValue) ? actionValue : null,
    currency,
    actorId: actor,
    orgId,
  };

  let advisory;
  try {
    advisory = assessFinancialGovernance(advisoryInput);
  } catch {
    // Never block on advisory failure
    warning("Financial governance advisory: assessment failed (non-fatal)");
    return;
  }

  // Set output
  setOutput("financial-governance-advice", JSON.stringify(advisory));

  // Log summary line
  info(`[Financial Governance Advisory] ${advisory.summary}`);
  for (const signal of advisory.signals) {
    info(`  • ${signal}`);
  }

  // Append formatted block to step summary
  const tierEmoji: Record<string, string> = {
    non_financial: "⚪",
    low: "🟢",
    medium: "🟡",
    high: "🟠",
    critical: "🔴",
  };
  const emoji = tierEmoji[advisory.riskTier] ?? "⚪";

  const signalLines =
    advisory.signals.length > 0
      ? advisory.signals.map((s) => `- ${s}`).join("\n")
      : "- No advisory signals";

  const summaryBlock = [
    "",
    "---",
    `## ${emoji} Financial Governance Advisory`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Risk Tier | \`${advisory.riskTier}\` |`,
    `| Risk Score | ${advisory.riskScore} / 100 |`,
    `| Evidence Required | ${advisory.evidenceRequired ? "**Yes**" : "No"} |`,
    `| Action Type | \`${actionType}\` |`,
    `| Actor | \`${actor}\` |`,
    `| Currency | ${currency} |`,
    actionValue !== null ? `| Action Value | $${actionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })} |` : `| Action Value | N/A |`,
    "",
    "### Advisory Signals",
    "",
    signalLines,
    "",
    "> **Advisory only** — this assessment is non-blocking and does not affect enforcement decisions.",
    "",
  ].join("\n");

  appendToStepSummary(summaryBlock);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  // 1. Read shared inputs
  const apiKey = getInput("api-key", true);
  // Mask immediately on the literal next line so any code path that
  // logs / reflects this value before the explicit mask call below has
  // no chance to print the plaintext key. The maskValue() call below
  // is kept as defense-in-depth (idempotent).
  maskValue(apiKey);

  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";

  maskValue(apiKey);

  // ── v2.1 batch path (scope-excluded from this unification) ─────────────────
  const evaluationsRaw = getInput("evaluations");
  if (evaluationsRaw) {
    const waitForId = getInput("wait-for-id") || undefined;
    const waitTimeoutMs = parseInt(getInput("wait-timeout-ms") || "600000", 10);
    const v2Batch = getInput("v2-batch") === "true";
    const v2Streaming = getInput("v2-streaming") === "true";

    let result;
    try {
      result = await runV21(
        {
          "INPUT_API-KEY": apiKey,
          "INPUT_API-URL": apiUrl,
          "INPUT_FAIL-ON-DENY": failOnDeny ? "true" : "false",
          INPUT_EVALUATIONS: evaluationsRaw,
          "INPUT_WAIT-FOR-ID": waitForId,
          "INPUT_WAIT-TIMEOUT-MS": String(waitTimeoutMs),
        },
        { v2Batch, v2Streaming },
      );
    } catch (err) {
      const msg =
        err instanceof EnforceError || err instanceof GateInfraError
          ? err.message
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      setOutput("verified", "false");
      setOutput("decisions", "[]");
      setOutput("batch-id", "");
      setFailed(`AtlaSent Gate (batch): ${msg}. Deploy blocked (fail-closed).`);
      return;
    }

    const decisionsJson = JSON.stringify(
      result.decisions.map((d) => ({
        decision: d.decision,
        verified: d.verified ?? false,
        evaluationId: d.id ?? "",
        permitToken: d.permitToken ? "(masked)" : "",
        reasons: d.reasons ?? [],
        verifyOutcome: d.verifyOutcome ?? "",
      })),
    );

    const allVerified = result.decisions.every(
      (d) => d.decision !== "allow" || d.verified === true,
    );

    setOutput("batch-id", result.batchId);
    setOutput("decisions", decisionsJson);
    setOutput("verified", allVerified ? "true" : "false");

    if (result.failed) {
      setFailed(
        `AtlaSent Gate: one or more evaluations were not allowed (deny/hold/escalate). See 'decisions' output for details.`,
      );
      return;
    }
    if (!allVerified) {
      setFailed(
        `AtlaSent Gate: one or more allow decisions failed permit verification. Deploy blocked.`,
      );
      return;
    }

    info(`AtlaSent Gate: all ${result.decisions.length} evaluation(s) allowed and verified`);
    info(`  Batch ID: ${result.batchId}`);
    return;
  }

  // ── Single-eval path via @atlasent/enforce ─────────────────────────────────
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id") || undefined;
  const explicitEnv = getInput("environment");
  let extraContext: Record<string, unknown> = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON — ignoring");
  }

  const gh = getGitHubContext();
  const environment = resolveEnvironment(explicitEnv, gh.ref, apiKey);
  // Use repository as org identifier for advisory purposes
  const orgId = gh.repository.split("/")[0] ?? "unknown";

  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "github:${actor}" in ${environment} environment` +
      (targetId ? ` (target=${targetId})` : ""),
  );

  // @atlasent/enforce is the canonical enforcement wrapper.
  // enforce() runs evaluate → verify (decision check) → verifyPermit (API call).
  // fn is a no-op: the action's job is to gate, not execute app logic.
  const config: EnforceConfig = {
    apiKey,
    apiUrl,
    action: actionType,
    actor: `github:${actor}`,
    environment,
    targetId,
    context: {
      source: "github-action",
      repository: gh.repository,
      ref: gh.ref,
      sha: gh.sha,
      workflow: gh.workflow,
      run_id: gh.run_id,
      run_number: gh.run_number,
      event_name: gh.event_name,
      pr_number: gh.pr_number ?? null,
      run_url: `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`,
      ...extraContext,
    },
  };

  let enforceResult: Awaited<ReturnType<typeof enforce>>;
  try {
    enforceResult = await enforce(config, async () => {});
  } catch (err) {
    if (err instanceof EnforceError) {
      // Set decision outputs before failing so they're visible in the step.
      if (err.decision) {
        setDecisionOutputs(err.decision);
      } else {
        setOutput("decision", "error");
        setOutput("permit-token", "");
        setOutput("evaluation-id", "");
        setOutput("proof-hash", "");
        setOutput("risk-score", "");
      }
      setOutput("verified", "false");

      // Emit financial governance advisory even on denied/error paths —
      // advisory mode is informational regardless of enforcement outcome.
      emitFinancialGovernanceAdvisory(actionType, actor, orgId);

      // phase="verify" is a policy decision; respect fail-on-deny.
      // All other phases are infrastructure/security failures: always fail-closed.
      if (err.phase === "verify" && !failOnDeny) {
        switch (err.decision?.decision) {
          case "deny":
            warning(`Authorization DENIED: ${err.decision.denyReason ?? "no reason provided"}`);
            break;
          case "hold":
            warning(`Authorization on HOLD: ${err.decision.holdReason ?? "awaiting approval"}`);
            break;
          case "escalate":
            warning("Authorization ESCALATED — manual review required");
            break;
          default:
            warning(`Authorization ${err.decision?.decision ?? "unknown"}`);
        }
        return;
      }

      // Fail-closed for evaluate + verify-permit phases, and verify when failOnDeny=true.
      switch (err.phase) {
        case "evaluate":
          setFailed(
            `AtlaSent Gate: ${err.message}. Deploy blocked — the gate cannot confirm authorization (fail-closed).`,
          );
          break;
        case "verify":
          switch (err.decision?.decision) {
            case "deny":
              setFailed(
                `Authorization DENIED: ${err.decision.denyReason ?? "no reason provided"}`,
              );
              break;
            case "hold":
              setFailed(
                `Authorization on HOLD: ${err.decision.holdReason ?? "awaiting approval"}`,
              );
              break;
            case "escalate":
              setFailed("Authorization ESCALATED — manual review required");
              break;
            default:
              setFailed(`Unexpected decision from AtlaSent: ${err.decision?.decision ?? "unknown"}`);
          }
          break;
        case "verify-permit":
          setFailed(
            `AtlaSent Gate: ${err.message}. Deploy blocked (fail-closed).`,
          );
          break;
        default:
          setFailed(`AtlaSent Gate: ${err.message}`);
      }
      return;
    }

    // Non-EnforceError: unexpected
    setOutput("decision", "error");
    setOutput("permit-token", "");
    setOutput("evaluation-id", "");
    setOutput("proof-hash", "");
    setOutput("risk-score", "");
    setOutput("verified", "false");

    // Still emit advisory on unexpected errors
    emitFinancialGovernanceAdvisory(actionType, actor, orgId);

    setFailed(
      `AtlaSent Gate: Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // enforce() returned — decision=allow, verify=passed, verifyPermit=passed.
  const { decision: d, verifyOutcome } = enforceResult;
  setDecisionOutputs(d);
  setOutput("verified", "true");

  info(`Authorization GRANTED (evaluate + verify)`);
  info(`  Permit token: (set as 'permit-token' output, masked in logs)`);
  info(`  Proof hash:   (set as 'proof-hash' output, masked in logs)`);
  info(`  Evaluation:   ${d.evaluationId ?? ""}`);
  if (d.riskScore !== undefined) info(`  Risk score:   ${d.riskScore}`);
  info(`  Verify:       ${verifyOutcome ?? "verified"}`);

  // Emit financial governance advisory after successful enforcement.
  // This is always the last step — non-blocking by design.
  emitFinancialGovernanceAdvisory(actionType, actor, orgId);
}

run().catch((err) => {
  console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
