// AtlaSent Gate Action — GitHub Actions entry point.
//
// Routing (in priority order):
//   release-mode set      → POST-deploy candidate registration + verify
//                           against atlasent-control-plane /v1/release/*
//   policy-sync=true      → v1-policy-sync (post bundle, fail CI on rejection)
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
import { runPolicySync } from "./policySync";
import {
  assessFinancialGovernance,
} from "./financialGovernanceAdvisory";
import type { FinancialAdvisoryInput } from "./financialGovernanceAdvisory";
import { emitEvidenceEvent } from "./evidenceClient";
import { registerAndVerify, summarizeOutcome } from "./releaseCandidate";
import { buildEvidenceBundle } from "./evidenceBundle";
import {
  LEGACY_PRODUCTION_DEPLOY_ALIAS,
  PRODUCTION_DEPLOY_ACTION,
  normalizeProtectedAction,
} from "./canonicalAction";

function getApiKey(): string {
  const apiKey = (process.env["ATLASENT_API_KEY"] ?? "").trim();
  if (!apiKey) {
    setFailed("ATLASENT_API_KEY is required");
  }
  return apiKey;
}

/**
 * Normalize the workflow-supplied `action` input to the canonical
 * Deploy Gate V1 string. Legacy alias `deployment.production` is
 * accepted and rewritten to `production.deploy`. Anything else
 * fails closed with `decision=error`.
 *
 * Returns the canonical string for downstream use. Callers should
 * use the returned value, NOT the raw input, so every downstream
 * surface (evaluate body, GH outputs, audit) carries the canonical.
 */
function normalizeAndValidateProtectedAction(actionType: string): string {
  const { canonical } = normalizeProtectedAction(actionType);
  if (canonical !== PRODUCTION_DEPLOY_ACTION) {
    setOutput("decision", "error");
    setOutput("verified", "false");
    setFailed(
      `AtlaSent Gate: unsupported protected action "${actionType}". ` +
        `Deploy Gate V1 only permits "${PRODUCTION_DEPLOY_ACTION}" ` +
        `(legacy alias "${LEGACY_PRODUCTION_DEPLOY_ALIAS}" is accepted during the V1 alias window).`,
    );
  }
  return canonical;
}

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
  setOutput("chain-entry", JSON.stringify(d.chainEntry ?? null));
  setOutput("snapshot", JSON.stringify(d.snapshot ?? null));
  setOutput("audit-hash", d.auditHash ?? "");
}

// ---------------------------------------------------------------------------
// Financial Governance Advisory — non-blocking, advisory only.
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
    warning("Financial governance advisory: assessment failed (non-fatal)");
    return;
  }

  setOutput("financial-governance-advice", JSON.stringify(advisory));

  info(`[Financial Governance Advisory] ${advisory.summary}`);
  for (const signal of advisory.signals) {
    info(`  • ${signal}`);
  }

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
    actionValue !== null
      ? `| Action Value | $${actionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })} |`
      : `| Action Value | N/A |`,
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
// Policy Sync step handler
// ---------------------------------------------------------------------------

async function runPolicySyncStep(apiKey: string, apiUrl: string): Promise<void> {
  const bundlePath = getInput("policy-bundle", true);
  const source = getInput("policy-source") || "github-action";
  const dryRun = getInput("policy-dry-run").toLowerCase() !== "false";
  const gh = getGitHubContext();

  info(
    `AtlaSent Policy Sync: submitting "${bundlePath}" ` +
      `(source=${source}, dry_run=${dryRun}, sha=${gh.sha.slice(0, 8)})`,
  );

  let result;
  try {
    result = await runPolicySync({
      apiKey,
      apiUrl,
      bundlePath,
      source,
      commitSha: gh.sha,
      ref: gh.ref,
      dryRun,
    });
  } catch (err) {
    setOutput("sync-run-id", "");
    setOutput("sync-status", "error");
    setOutput("sync-diff", "");
    setOutput("sync-summary", "");
    setFailed(
      `AtlaSent Policy Sync: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const { run, diff, rejected } = result;

  setOutput("sync-run-id", run.id ?? "");
  setOutput("sync-status", run.status);
  setOutput("sync-diff", diff);
  setOutput(
    "sync-summary",
    JSON.stringify({
      added: run.policies_added,
      updated: run.policies_updated,
      removed: run.policies_removed,
      status: run.status,
    }),
  );

  appendToStepSummary(
    [
      "",
      "## 📋 AtlaSent Policy Sync",
      "",
      `| Field | Value |`,
      `|---|---|`,
      `| Run ID | \`${run.id ?? "n/a"}\` |`,
      `| Status | \`${run.status}\` |`,
      `| Mode | ${dryRun ? "Dry run (preview only)" : "Applied"} |`,
      `| Changes | ${diff} |`,
      `| Source | \`${source}\` |`,
      `| Ref | \`${gh.ref}\` |`,
      `| Commit | \`${gh.sha.slice(0, 8)}\` |`,
      "",
    ].join("\n"),
  );

  if (rejected) {
    setFailed(
      `AtlaSent Policy Sync: bundle ${run.status} — ${diff}. ` +
        `Fix policy errors and push again.`,
    );
    return;
  }

  if (dryRun) {
    info(`Policy sync dry run: ${diff}`);
    info(`  Run ID: ${run.id}`);
    info(`  Set policy-dry-run: 'false' on the default branch to apply.`);
  } else {
    info(`Policy sync applied: ${diff}`);
    info(`  Run ID: ${run.id}`);
  }
}

// ---------------------------------------------------------------------------
// Release-candidate post-deploy mode
// ---------------------------------------------------------------------------

async function runReleaseModeStep(): Promise<void> {
  const cpUrl = getInput("control-plane-url", true);
  const cpToken =
    getInput("control-plane-token") || (process.env["ATLASENT_CP_TOKEN"] ?? "").trim();
  if (!cpToken) {
    setFailed(
      "release-mode: control-plane-token input or ATLASENT_CP_TOKEN env var is required",
    );
    return;
  }
  maskValue(cpToken);

  const targetUrl = getInput("release-target-runtime-url", true);
  const gh = getGitHubContext();
  const repo = getInput("release-repo") || gh.repository;
  const commitSha = getInput("release-commit-sha") || gh.sha;
  if (!commitSha) {
    setFailed("release-mode: commit SHA is required (set release-commit-sha or GITHUB_SHA)");
    return;
  }
  const imageDigest = getInput("release-image-digest") || undefined;
  const semver = getInput("release-semver") || undefined;
  const environment = getInput("release-environment", true) as
    | "preview"
    | "staging"
    | "production";
  if (!["preview", "staging", "production"].includes(environment)) {
    setFailed(
      `release-mode: release-environment must be preview | staging | production (got "${environment}")`,
    );
    return;
  }
  const failOnVerify = getInput("release-fail-on-verify").toLowerCase() !== "false";

  info(
    `AtlaSent release: registering candidate for ${repo}@${commitSha.slice(0, 8)} in ${environment} against ${targetUrl}`,
  );

  let result;
  try {
    result = await registerAndVerify({
      controlPlaneUrl: cpUrl,
      controlPlaneToken: cpToken,
      targetRuntimeUrl: targetUrl,
      repo,
      commitSha,
      imageDigest,
      semver,
      environment,
    });
  } catch (err) {
    setOutput("release-candidate-id", "");
    setOutput("release-runtime-status", "error");
    setOutput("release-deploy-status", "error");
    setOutput("release-runtime-result", "{}");
    setOutput("release-deploy-result", "{}");
    setFailed(
      `AtlaSent release: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  setOutput("release-candidate-id", result.candidateId);
  setOutput("release-runtime-status", result.runtime.status);
  setOutput("release-deploy-status", result.deploy.status);
  setOutput("release-runtime-result", JSON.stringify(result.runtime));
  setOutput("release-deploy-result", JSON.stringify(result.deploy));

  const runtimeSummary = summarizeOutcome(result.runtime);
  const deploySummary = summarizeOutcome(result.deploy);

  info(`  Candidate: ${result.candidateId}`);
  info(`  Runtime verify: ${result.runtime.status}`);
  for (const c of result.runtime.checks) {
    info(`    • ${c.name}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  info(`  Deploy verify: ${result.deploy.status}`);
  for (const c of result.deploy.checks) {
    info(`    • ${c.name}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}`);
  }

  appendToStepSummary(
    [
      "",
      "## 🚀 AtlaSent Release Candidate",
      "",
      `| Field | Value |`,
      `|---|---|`,
      `| Candidate ID | \`${result.candidateId}\` |`,
      `| Repo | \`${repo}\` |`,
      `| Commit | \`${commitSha.slice(0, 8)}\` |`,
      `| Environment | \`${environment}\` |`,
      `| Runtime verify | ${runtimeSummary.level === "passed" ? "✅" : runtimeSummary.level === "warned" ? "⚠️" : "❌"} \`${result.runtime.status}\` |`,
      `| Deploy verify | ${deploySummary.level === "passed" ? "✅" : deploySummary.level === "warned" ? "⚠️" : "❌"} \`${result.deploy.status}\` |`,
      "",
    ].join("\n"),
  );

  if (failOnVerify && (!runtimeSummary.ok || !deploySummary.ok)) {
    const failed: string[] = [];
    if (!runtimeSummary.ok) failed.push(`runtime=${result.runtime.status}`);
    if (!deploySummary.ok) failed.push(`deploy=${result.deploy.status}`);
    setFailed(
      `AtlaSent release: verification failed (${failed.join(", ")}). Promotion should not proceed.`,
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  // ── Release-mode path (post-deploy verification) ───────────────────────────
  // Runs against the control-plane, not the runtime — does NOT require
  // ATLASENT_API_KEY. Routed first so it can short-circuit before the other
  // paths' input requirements.
  if (getInput("release-mode") === "register-and-verify") {
    await runReleaseModeStep();
    return;
  }

  // 1. Read shared inputs
  const apiKey = getApiKey();
  maskValue(apiKey);

  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";

  maskValue(apiKey);

  // ── Policy sync path ────────────────────────────────────────────────────────
  if (getInput("policy-sync").toLowerCase() === "true") {
    await runPolicySyncStep(apiKey, apiUrl);
    return;
  }

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
          ATLASENT_API_KEY: apiKey,
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
  // Normalize the raw input to the canonical (`production.deploy`) before
  // any downstream use. Legacy callers passing `deployment.production`
  // continue to work; the evaluate body, GH outputs, and audit context
  // all carry the canonical string from here on.
  const rawActionType = getInput("action", true);
  const actionType = normalizeAndValidateProtectedAction(rawActionType);
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
  const orgId = gh.repository.split("/")[0] ?? "unknown";

  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "github:${actor}" in ${environment} environment` +
      (targetId ? ` (target=${targetId})` : ""),
  );

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
      if (err.decision) {
        setDecisionOutputs(err.decision);
      } else {
        setOutput("decision", "error");
        setOutput("permit-token", "");
        setOutput("evaluation-id", "");
        setOutput("proof-hash", "");
        setOutput("risk-score", "");
        setOutput("chain-entry", JSON.stringify(null));
        setOutput("snapshot", JSON.stringify(null));
        setOutput("audit-hash", "");
      }
      setOutput("verified", "false");
      setOutput("evidence-receipt", JSON.stringify(null));
      setOutput("evidence-bundle", JSON.stringify(null));

      emitFinancialGovernanceAdvisory(actionType, actor, orgId);

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

    setOutput("decision", "error");
    setOutput("permit-token", "");
    setOutput("evaluation-id", "");
    setOutput("proof-hash", "");
    setOutput("risk-score", "");
    setOutput("chain-entry", JSON.stringify(null));
    setOutput("snapshot", JSON.stringify(null));
    setOutput("audit-hash", "");
    setOutput("verified", "false");
    setOutput("evidence-receipt", JSON.stringify(null));
    setOutput("evidence-bundle", JSON.stringify(null));

    emitFinancialGovernanceAdvisory(actionType, actor, orgId);

    setFailed(
      `AtlaSent Gate: Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const { decision: d, verifyOutcome } = enforceResult;
  setDecisionOutputs(d);
  setOutput("verified", "true");

  info(`Authorization GRANTED (evaluate + verify)`);
  info(`  Permit token: (set as 'permit-token' output, masked in logs)`);
  info(`  Proof hash:   (set as 'proof-hash' output, masked in logs)`);
  info(`  Evaluation:   ${d.evaluationId ?? ""}`);
  if (d.riskScore !== undefined) info(`  Risk score:   ${d.riskScore}`);
  info(`  Verify:       ${verifyOutcome ?? "verified"}`);

  // ── Build evidence bundle ─────────────────────────────────────────────────
  // Best-effort: evidence output failures must never block the gate decision.
  try {
    const receiptSigningSecret = process.env["ATLASENT_RECEIPT_SIGNING_SECRET"];
    const receiptSigningKeyId = getInput("receipt-signing-key-id");
    const runUrl = `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`;

    const bundle = buildEvidenceBundle({
      evaluationId: d.evaluationId ?? "",
      permitToken: d.permitToken ?? "",
      auditHash: d.auditHash,
      action: actionType,
      actor: `github:${actor}`,
      environment,
      repository: gh.repository,
      sha: gh.sha,
      runId: gh.run_id,
      runUrl,
      signingSecret: receiptSigningSecret || undefined,
      signingKeyId: receiptSigningKeyId || undefined,
    });

    setOutput("evidence-receipt", JSON.stringify(bundle.receipt));
    setOutput("evidence-bundle", JSON.stringify(bundle));
    info(
      `  Evidence:     receipt=${bundle.receipt.receipt_id} algorithm=${bundle.receipt.algorithm}`,
    );
  } catch (bundleErr) {
    warning(
      `AtlaSent: evidence bundle build failed (advisory; gate decision unaffected): ${
        bundleErr instanceof Error ? bundleErr.message : String(bundleErr)
      }`,
    );
    setOutput("evidence-receipt", JSON.stringify(null));
    setOutput("evidence-bundle", JSON.stringify(null));
  }

  // ── B7: emit execution_started evidence event ────────────────────────────
  // Best-effort, fire-and-forget. Build outcome is already determined above.
  if (d.permitToken && d.evaluationId) {
    await emitEvidenceEvent(
      { apiKey, apiUrl },
      {
        event_type: "execution_started",
        permit_token: d.permitToken,
        evaluation_id: d.evaluationId,
        environment,
        execution_started_at: new Date().toISOString(),
        metadata: {
          source: "github-action",
          repository: gh.repository,
          ref: gh.ref,
          sha: gh.sha,
          workflow: gh.workflow,
          run_id: gh.run_id,
          run_url: `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`,
          action: actionType,
          actor: `github:${actor}`,
        },
      },
      { info, warning },
    );
  }

  emitFinancialGovernanceAdvisory(actionType, actor, orgId);
}

if (require.main === module) {
  run().catch((err) => {
    console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
