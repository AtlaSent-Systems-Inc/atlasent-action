import { evaluate, EnforceError } from "@atlasent/enforce";

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

function getGitHubContext() {
  const repository = process.env["GITHUB_REPOSITORY"] ?? "";
  const run_id = process.env["GITHUB_RUN_ID"] ?? "";
  const server_url = process.env["GITHUB_SERVER_URL"] ?? "https://github.com";
  return {
    repository,
    ref: process.env["GITHUB_REF"] ?? "",
    sha: process.env["GITHUB_SHA"] ?? "",
    run_id,
    run_number: process.env["GITHUB_RUN_NUMBER"] ?? "",
    workflow: process.env["GITHUB_WORKFLOW"] ?? "",
    event_name: process.env["GITHUB_EVENT_NAME"] ?? "",
    pr_number: process.env["GITHUB_REF"]?.match(/^refs\/pull\/(\d+)\//)?.[1],
    run_url: `${server_url}/${repository}/actions/runs/${run_id}`,
  };
}

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

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
  const apiKey = getInput("api-key", true);
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id") || undefined;
  const explicitEnv = getInput("environment");
  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";

  let extraContext: Record<string, unknown> = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON — ignoring");
  }

  maskValue(apiKey);

  const gh = getGitHubContext();
  const environment = resolveEnvironment(explicitEnv, gh.ref, apiKey);

  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment` +
      (targetId ? ` (target=${targetId})` : ""),
  );

  let decision;
  try {
    decision = await evaluate({
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
        run_url: gh.run_url,
        ...extraContext,
      },
    });
  } catch (err) {
    setOutput("decision", "error");
    setFailed(err instanceof EnforceError ? err.message : String(err));
  }

  const permitToken = decision.permitToken ?? "";
  const evaluationId = decision.evaluationId ?? "";
  const proofHash = decision.proofHash ?? "";
  const riskScore = decision.riskScore !== undefined ? String(decision.riskScore) : "";

  if (permitToken) maskValue(permitToken);
  if (proofHash) maskValue(proofHash);

  setOutput("decision", decision.decision);
  setOutput("permit-token", permitToken);
  setOutput("evaluation-id", evaluationId);
  setOutput("proof-hash", proofHash);
  setOutput("risk-score", riskScore);

  switch (decision.decision) {
    case "allow":
      info("Authorization GRANTED");
      info("  Permit token: (set as 'permit-token' output, masked in logs)");
      info("  Proof hash:   (set as 'proof-hash' output, masked in logs)");
      info(`  Evaluation:   ${evaluationId}`);
      if (riskScore) info(`  Risk score:   ${riskScore}`);
      break;

    case "deny":
      if (failOnDeny) {
        setFailed(`Authorization DENIED: ${decision.denyReason ?? "no reason provided"}`);
      } else {
        warning(`Authorization DENIED: ${decision.denyReason ?? "no reason provided"}`);
      }
      break;

    case "hold":
      if (failOnDeny) {
        setFailed(`Authorization on HOLD: ${decision.holdReason ?? "awaiting approval"}`);
      } else {
        warning(`Authorization on HOLD: ${decision.holdReason ?? "awaiting approval"}`);
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
      warning(`Unexpected decision: ${String(decision.decision)}`);
      if (failOnDeny) {
        setFailed(`Unexpected decision from AtlaSent: ${String(decision.decision)}`);
      }
  }
}

run().catch((err) => {
  console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
