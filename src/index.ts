// AtlaSent Gate Action — GitHub Actions entry point.
// HTTP logic lives in src/gate.ts (evaluate → v1-verify-permit, fail-closed).
// This file handles GH Actions I/O: reading inputs, masking secrets, and
// translating GateResult / GateInfraError into step outputs and exit codes.

import { GateInfraError, runGate } from "./gate";

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
    pr_number: process.env["GITHUB_REF"]?.match(/^refs\/pull\/(\d+)\//)?.[1],
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
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  // 1. Read inputs
  const apiKey = getInput("api-key", true);
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id");
  const explicitEnv = getInput("environment");
  const apiUrl =
    getInput("api-url") || "https://ihghhasvxtltlbizvkqy.supabase.co/functions/v1";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  let extraContext: Record<string, unknown> = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON — ignoring");
  }

  maskValue(apiKey);

  // 2. Build evaluate payload
  const gh = getGitHubContext();
  const environment = resolveEnvironment(explicitEnv, gh.ref, apiKey);

  const payload: Record<string, unknown> = {
    action_type: actionType,
    actor_id: `github:${actor}`,
    context: {
      environment,
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
      ...(targetId ? { target_id: targetId } : {}),
      ...extraContext,
    },
  };
  if (targetId) payload["target_id"] = targetId;

  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment` +
      (targetId ? ` (target=${targetId})` : ""),
  );

  // 3. Run gate (v1-evaluate → v1-verify-permit, fail-closed end-to-end).
  //    Infrastructure errors (network, 5xx, 401, 429, no permit_token) always
  //    throw GateInfraError and are never mistaken for policy decisions.
  let result;
  try {
    result = await runGate({
      apiUrl,
      apiKey,
      actionType,
      actorId: `github:${actor}`,
      payload,
    });
  } catch (err) {
    const msg =
      err instanceof GateInfraError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    setOutput("decision", "error");
    setOutput("verified", "false");
    setFailed(
      `AtlaSent Gate: ${msg}. Deploy blocked — the gate cannot confirm authorization (fail-closed).`,
    );
    return;
  }

  // Mask sensitive outputs before they touch logs
  if (result.permitToken) maskValue(result.permitToken);
  if (result.proofHash) maskValue(result.proofHash);

  // 4. Set outputs
  setOutput("decision", result.decision);
  setOutput("permit-token", result.permitToken);
  setOutput("evaluation-id", result.evaluationId);
  setOutput("proof-hash", result.proofHash);
  setOutput("risk-score", result.riskScore);
  setOutput("verified", result.verified ? "true" : "false");

  // 5. Handle result
  if (result.ok) {
    info(`Authorization GRANTED (evaluate + verify)`);
    info(`  Permit token: (set as 'permit-token' output, masked in logs)`);
    info(`  Proof hash:   (set as 'proof-hash' output, masked in logs)`);
    info(`  Evaluation:   ${result.evaluationId}`);
    if (result.riskScore) info(`  Risk score:   ${result.riskScore}`);
    info(`  Verify:       ${result.verifyOutcome}`);
    return;
  }

  // Non-allow decisions or verify=false
  if (result.decision === "allow") {
    // verify returned verified=false (replay / expired permit)
    setFailed(
      `Permit verification failed (outcome=${result.verifyOutcome ?? "unknown"}). ` +
        `Deploy blocked. This typically means the permit was already consumed ` +
        `by an earlier verify, or it expired.`,
    );
    return;
  }

  switch (result.decision) {
    case "deny":
      if (failOnDeny) {
        setFailed(`Authorization DENIED: ${result.reason || "no reason provided"}`);
      } else {
        warning(`Authorization DENIED: ${result.reason || "no reason provided"}`);
      }
      break;

    case "hold":
      if (failOnDeny) {
        setFailed(`Authorization on HOLD: ${result.reason || "awaiting approval"}`);
      } else {
        warning(`Authorization on HOLD: ${result.reason || "awaiting approval"}`);
      }
      break;

    case "escalate":
      if (failOnDeny) {
        setFailed("Authorization ESCALATED — manual review required");
      } else {
        warning("Authorization ESCALATED — manual review required");
      }
      break;

    default:
      warning(`Unexpected decision: ${result.decision}`);
      if (failOnDeny) {
        setFailed(`Unexpected decision from AtlaSent: ${result.decision}`);
      }
  }
}

run().catch((err) => {
  console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
