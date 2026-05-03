"use strict";

// dist/index.js — self-contained CommonJS bundle for atlasent-action.
// Generated from src/index.ts, src/gate.ts, src/batch.ts, src/stream.ts,
// src/inputs.ts, src/types.ts, src/v21.ts.
// Regenerate with: npm run build

// ---------------------------------------------------------------------------
// src/gate.ts — verify-permit helper
// ---------------------------------------------------------------------------

class GateInfraError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "GateInfraError";
    this.statusCode = statusCode;
  }
}

async function verifyOne(params) {
  const path = params.verifyPath ?? "/v1-verify-permit";
  let res;
  try {
    res = await fetch(`${params.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        permit_token: params.permitToken,
        action_type: params.actionType,
        actor_id: params.actorId,
      }),
    });
  } catch (err) {
    throw new GateInfraError(
      `verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new GateInfraError(`verify-permit HTTP ${res.status}`, res.status);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new GateInfraError("failed to parse verify-permit response as JSON");
  }
  return { verified: body.verified === true, outcome: body.outcome };
}

// ---------------------------------------------------------------------------
// src/batch.ts — batch fan-out helper
// ---------------------------------------------------------------------------

async function evaluateMany(apiUrl, apiKey, items, v2Batch) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  let decisions;
  let batchId;

  if (v2Batch) {
    const r = await fetch(`${apiUrl}/v1/evaluate/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items }),
    });
    if (!r.ok) {
      throw new Error(`atlasent /v1/evaluate/batch ${r.status}`);
    }
    const data = await r.json();
    decisions = data.results;
    batchId = data.batchId;
  } else {
    decisions = [];
    for (const item of items) {
      const r = await fetch(`${apiUrl}/v1/evaluate`, {
        method: "POST",
        headers,
        body: JSON.stringify(item),
      });
      if (!r.ok) {
        throw new Error(`atlasent /v1/evaluate ${r.status}`);
      }
      decisions.push(await r.json());
    }
    batchId = `loop-${Date.now()}`;
  }

  const verified = await Promise.all(
    decisions.map(async (d, i) => {
      if (d.decision !== "allow" || !d.permitToken) {
        return { ...d, verified: d.decision === "allow" ? false : undefined };
      }
      const item = items[i];
      const result = await verifyOne({
        apiUrl,
        apiKey,
        actionType: item.action,
        actorId: item.actor,
        permitToken: d.permitToken,
        verifyPath: "/v1/verify-permit",
      });
      return { ...d, verified: result.verified, verifyOutcome: result.outcome };
    }),
  );

  return { decisions: verified, batchId };
}

// ---------------------------------------------------------------------------
// src/stream.ts — streaming-wait helper
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const SSE_LINE = /^data: (.+)$/;

async function waitForTerminalDecision(opts) {
  if (opts.v2Streaming) {
    return waitViaStream(opts);
  }
  return waitViaPolling(opts);
}

async function waitViaStream(opts) {
  const r = await fetch(`${opts.apiUrl}/v1/evaluate/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({ evaluationId: opts.evaluationId }),
    signal: opts.signal,
  });
  if (!r.ok || !r.body) {
    throw new Error(`atlasent /v1/evaluate/stream ${r.status}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + opts.timeoutMs;
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        const m = SSE_LINE.exec(line);
        if (!m) continue;
        const event = JSON.parse(m[1]);
        if (event.decision === "allow" || event.decision === "deny") {
          return event;
        }
      }
    }
  }
  throw new Error(
    `atlasent stream timeout after ${opts.timeoutMs}ms for ${opts.evaluationId}`,
  );
}

async function waitViaPolling(opts) {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(
        `${opts.apiUrl}/v1/evaluate/${encodeURIComponent(opts.evaluationId)}`,
        {
          headers: { authorization: `Bearer ${opts.apiKey}` },
          signal: opts.signal,
        },
      );
      if (r.ok) {
        const decision = await r.json();
        if (decision.decision === "allow" || decision.decision === "deny") {
          return decision;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(
    `atlasent poll timeout after ${opts.timeoutMs}ms for ${opts.evaluationId}`,
  );
}

// ---------------------------------------------------------------------------
// src/inputs.ts — input parser
// ---------------------------------------------------------------------------

function parseInputs(env) {
  const apiKey = requiredInput(env, "INPUT_API-KEY");
  const apiUrl = env["INPUT_API-URL"] || "https://api.atlasent.io";
  const failOnDeny = (env["INPUT_FAIL-ON-DENY"] || "true") === "true";

  const evaluationsRaw = env["INPUT_EVALUATIONS"];
  if (evaluationsRaw && evaluationsRaw.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(evaluationsRaw);
    } catch {
      throw new Error("`evaluations` is not valid JSON — expected a JSON array of evaluation requests");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("`evaluations` must be a non-empty JSON array of evaluation requests");
    }
    return {
      apiKey,
      apiUrl,
      failOnDeny,
      evaluations: parsed,
      waitForId: env["INPUT_WAIT-FOR-ID"] || undefined,
      waitTimeoutMs: parseInt(env["INPUT_WAIT-TIMEOUT-MS"] || "600000", 10),
    };
  }

  const action = requiredInput(env, "INPUT_ACTION");
  const actor = env["INPUT_ACTOR"] || env["GITHUB_ACTOR"] || "unknown";
  const environment = env["INPUT_ENVIRONMENT"];
  const contextRaw = env["INPUT_CONTEXT"] || "{}";
  let context = {};
  try {
    context = JSON.parse(contextRaw);
  } catch {
    throw new Error("`context` is not valid JSON — expected a JSON object");
  }

  return {
    apiKey,
    apiUrl,
    failOnDeny,
    single: { action, actor, environment, context },
    waitForId: env["INPUT_WAIT-FOR-ID"] || undefined,
    waitTimeoutMs: parseInt(env["INPUT_WAIT-TIMEOUT-MS"] || "600000", 10),
  };
}

function requiredInput(env, key) {
  const v = env[key];
  if (!v) {
    throw new Error(`Missing required input: ${key.replace("INPUT_", "").toLowerCase()}`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// src/v21.ts — v2.1 entry point
// ---------------------------------------------------------------------------

async function runV21(env, flags) {
  const inputs = parseInputs(env);
  const items = inputs.evaluations ?? [inputs.single];

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
          : { verified: false, outcome: undefined };
        decisions[idx] = { ...terminal, verified: vr.verified, verifyOutcome: vr.outcome };
      } else {
        decisions[idx] = terminal;
      }
    }
  }

  const failed =
    inputs.failOnDeny &&
    decisions.some(
      (d) => d.decision === "deny" || d.decision === "hold" || d.decision === "escalate",
    );

  return { decisions, failed, batchId: batch.batchId };
}

// ---------------------------------------------------------------------------
// src/index.ts — GitHub Actions entry point
// ---------------------------------------------------------------------------

const { enforce, EnforceError } = require("@atlasent/enforce");

function getInput(name, required = false) {
  const envKey = `INPUT_${name.replace(/-/g, "_").toUpperCase()}`;
  const val = (process.env[envKey] ?? "").trim();
  if (required && !val) {
    setFailed(`Input required and not supplied: ${name}`);
  }
  return val;
}

function setOutput(name, value) {
  const outputFile = process.env["GITHUB_OUTPUT"];
  if (outputFile) {
    const fs = require("node:fs");
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
  console.log(`::set-output name=${name}::${value}`);
}

function setFailed(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function warning(message) {
  console.log(`::warning::${message}`);
}

function info(message) {
  console.log(message);
}

function maskValue(value) {
  console.log(`::add-mask::${value}`);
}

function getGitHubContext() {
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

function resolveEnvironment(explicit, ref, apiKey) {
  if (explicit) return explicit;
  if (apiKey.startsWith("ask_test_")) return "test";
  if (apiKey.startsWith("ask_live_")) return "live";
  const branch = ref.replace("refs/heads/", "");
  return branch === "main" || branch === "master" ? "live" : "test";
}

function setDecisionOutputs(d) {
  if (d.permitToken) maskValue(d.permitToken);
  if (d.proofHash) maskValue(d.proofHash);
  setOutput("decision", d.decision);
  setOutput("permit-token", d.permitToken ?? "");
  setOutput("evaluation-id", d.evaluationId ?? "");
  setOutput("proof-hash", d.proofHash ?? "");
  setOutput("risk-score", d.riskScore !== undefined ? String(d.riskScore) : "");
}

async function run() {
  const apiKey = getInput("api-key", true);
  maskValue(apiKey);

  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";

  maskValue(apiKey);

  // v2.1 batch path
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

  // Single-eval path via @atlasent/enforce
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id") || undefined;
  const explicitEnv = getInput("environment");
  let extraContext = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON — ignoring");
  }

  const gh = getGitHubContext();
  const environment = resolveEnvironment(explicitEnv, gh.ref, apiKey);

  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "github:${actor}" in ${environment} environment` +
      (targetId ? ` (target=${targetId})` : ""),
  );

  const config = {
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

  let enforceResult;
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
      }
      setOutput("verified", "false");

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
    setOutput("verified", "false");
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
}

run().catch((err) => {
  console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
