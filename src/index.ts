import { evaluate, EnforceError } from "@atlasent/enforce";
import type { Decision as EnforceDecision } from "@atlasent/enforce";
import { evaluateMany } from "./batch";
import { waitForTerminalDecision } from "./stream";
import type { Decision as LocalDecision, EvaluateRequest } from "./types";

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
// Unified gate result — bridges @atlasent/enforce and ./types shapes
// ---------------------------------------------------------------------------

interface GateResult {
  decision: string;
  evaluationId: string;
  permitToken: string;
  proofHash: string;
  riskScore: string;
  denyReason?: string;
  holdReason?: string;
}

function fromEnforceDecision(d: EnforceDecision): GateResult {
  return {
    decision: d.decision,
    evaluationId: d.evaluationId ?? "",
    permitToken: d.permitToken ?? "",
    proofHash: d.proofHash ?? "",
    riskScore: d.riskScore !== undefined ? String(d.riskScore) : "",
    denyReason: d.denyReason,
    holdReason: d.holdReason,
  };
}

function fromLocalDecision(d: LocalDecision): GateResult {
  return {
    decision: d.decision,
    evaluationId: d.id ?? "",
    permitToken: d.permitToken ?? "",
    proofHash: d.proofHash ?? "",
    riskScore: "",
    denyReason: d.reasons?.[0],
    holdReason: d.reasons?.[0],
  };
}

// ---------------------------------------------------------------------------
// Output + logging for a single gate result
// ---------------------------------------------------------------------------

function applyResult(result: GateResult, failOnDeny: boolean): void {
  const { decision, evaluationId, permitToken, proofHash, riskScore } = result;

  if (permitToken) maskValue(permitToken);
  if (proofHash) maskValue(proofHash);

  setOutput("decision", decision);
  setOutput("permit-token", permitToken);
  setOutput("evaluation-id", evaluationId);
  setOutput("proof-hash", proofHash);
  setOutput("risk-score", riskScore);

  switch (decision) {
    case "allow":
      info("Authorization GRANTED");
      info("  Permit token: (set as 'permit-token' output, masked in logs)");
      info("  Proof hash:   (set as 'proof-hash' output, masked in logs)");
      info(`  Evaluation:   ${evaluationId}`);
      if (riskScore) info(`  Risk score:   ${riskScore}`);
      break;
    case "deny":
      if (failOnDeny) {
        setFailed(`Authorization DENIED: ${result.denyReason ?? "no reason provided"}`);
      } else {
        warning(`Authorization DENIED: ${result.denyReason ?? "no reason provided"}`);
      }
      break;
    case "hold":
      if (failOnDeny) {
        setFailed(`Authorization on HOLD: ${result.holdReason ?? "awaiting approval"}`);
      } else {
        warning(`Authorization on HOLD: ${result.holdReason ?? "awaiting approval"}`);
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
      warning(`Unexpected decision: ${decision}`);
      if (failOnDeny) setFailed(`Unexpected decision from AtlaSent: ${decision}`);
  }
}

// ---------------------------------------------------------------------------
// Aggregate decision across a batch
// ---------------------------------------------------------------------------

function aggregateDecision(decisions: LocalDecision[]): string {
  if (decisions.some((d) => d.decision === "deny")) return "deny";
  if (decisions.some((d) => d.decision === "hold")) return "hold";
  if (decisions.some((d) => d.decision === "escalate")) return "escalate";
  return "allow";
}

// ---------------------------------------------------------------------------
// Single-eval path (Alpha — evaluate one action via @atlasent/enforce)
// ---------------------------------------------------------------------------

async function runSingle(opts: {
  apiKey: string;
  apiUrl: string;
  failOnDeny: boolean;
  waitForId: string | undefined;
  waitTimeoutMs: number;
  v2Streaming: boolean;
}): Promise<void> {
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
  const environment = resolveEnvironment(explicitEnv, gh.ref, opts.apiKey);

  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment` +
      (targetId ? ` (target=${targetId})` : ""),
  );

  let enforceDecision: EnforceDecision;
  try {
    enforceDecision = await evaluate({
      apiKey: opts.apiKey,
      apiUrl: opts.apiUrl,
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

  // Streaming-wait: if hold/escalate and this evaluation is the one to wait on
  if (
    opts.waitForId &&
    enforceDecision.evaluationId === opts.waitForId &&
    (enforceDecision.decision === "hold" || enforceDecision.decision === "escalate")
  ) {
    info(`Waiting for terminal decision on evaluation ${opts.waitForId}...`);
    const terminal = await waitForTerminalDecision({
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      evaluationId: opts.waitForId,
      timeoutMs: opts.waitTimeoutMs,
      v2Streaming: opts.v2Streaming,
    });
    applyResult(fromLocalDecision(terminal), opts.failOnDeny);
    return;
  }

  applyResult(fromEnforceDecision(enforceDecision), opts.failOnDeny);
}

// ---------------------------------------------------------------------------
// Batch path (Beta — fan out via evaluateMany)
// ---------------------------------------------------------------------------

async function runBatch(opts: {
  apiKey: string;
  apiUrl: string;
  failOnDeny: boolean;
  evaluationsRaw: string;
  waitForId: string | undefined;
  waitTimeoutMs: number;
  v2Batch: boolean;
  v2Streaming: boolean;
}): Promise<void> {
  let items: EvaluateRequest[];
  try {
    const parsed: unknown = JSON.parse(opts.evaluationsRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("must be a non-empty JSON array");
    }
    items = parsed as EvaluateRequest[];
  } catch (err) {
    setOutput("decision", "error");
    setFailed(
      `Invalid 'evaluations' input: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  info(`AtlaSent Gate: evaluating ${items.length} action(s) in batch`);

  let { decisions } = await evaluateMany(opts.apiUrl, opts.apiKey, items, opts.v2Batch);

  // Streaming-wait: find the matching hold/escalate and wait for it
  if (opts.waitForId) {
    const idx = decisions.findIndex(
      (d) =>
        d.id === opts.waitForId &&
        (d.decision === "hold" || d.decision === "escalate"),
    );
    if (idx >= 0) {
      info(`Waiting for terminal decision on evaluation ${opts.waitForId}...`);
      const terminal = await waitForTerminalDecision({
        apiUrl: opts.apiUrl,
        apiKey: opts.apiKey,
        evaluationId: opts.waitForId,
        timeoutMs: opts.waitTimeoutMs,
        v2Streaming: opts.v2Streaming,
      });
      decisions = [...decisions];
      decisions[idx] = terminal;
    }
  }

  const agg = aggregateDecision(decisions);
  setOutput("decision", agg);
  setOutput("decisions-json", JSON.stringify(decisions));

  if (agg === "allow") {
    info(`Authorization GRANTED for all ${decisions.length} evaluation(s)`);
  } else {
    const counts = decisions.reduce<Record<string, number>>((acc, d) => {
      acc[d.decision] = (acc[d.decision] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    if (opts.failOnDeny) {
      setFailed(`Batch gate not fully authorized: ${summary}`);
    } else {
      warning(`Batch gate not fully authorized: ${summary}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const apiKey = getInput("api-key", true);
  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  const evaluationsRaw = getInput("evaluations");
  const waitForId = getInput("wait-for-id") || undefined;
  const waitTimeoutMs = parseInt(getInput("wait-timeout-ms") || "600000", 10);

  // Tenant flags — defaults to fallback path until control-plane integration lands
  const v2Batch = process.env["ATLASENT_V2_BATCH"] === "true";
  const v2Streaming = process.env["ATLASENT_V2_STREAMING"] === "true";

  maskValue(apiKey);

  if (evaluationsRaw.trim()) {
    await runBatch({ apiKey, apiUrl, failOnDeny, evaluationsRaw, waitForId, waitTimeoutMs, v2Batch, v2Streaming });
  } else {
    await runSingle({ apiKey, apiUrl, failOnDeny, waitForId, waitTimeoutMs, v2Streaming });
  }
}

run().catch((err) => {
  console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
