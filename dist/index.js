"use strict";

// src/gate.ts
var GateInfraError = class extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.name = "GateInfraError";
  }
};
async function verifyOne(params) {
  const path = params.verifyPath ?? "/v1-verify-permit";
  let res;
  try {
    res = await fetch(`${params.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        permit_token: params.permitToken,
        action_type: params.actionType,
        actor_id: params.actorId
      })
    });
  } catch (err) {
    throw new GateInfraError(
      `verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`
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
async function runGate(params) {
  let evalRes;
  try {
    evalRes = await fetch(`${params.apiUrl}/v1-evaluate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify(params.payload)
    });
  } catch (err) {
    throw new GateInfraError(
      `evaluate unreachable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (evalRes.status >= 500) {
    throw new GateInfraError(
      `evaluate HTTP ${evalRes.status} \u2014 infrastructure failure, not a policy decision`,
      evalRes.status
    );
  }
  if (evalRes.status === 401 || evalRes.status === 403) {
    throw new GateInfraError(
      `evaluate auth failed (HTTP ${evalRes.status}). Check ATLASENT_API_KEY scopes.`,
      evalRes.status
    );
  }
  if (evalRes.status === 429) {
    throw new GateInfraError(
      `evaluate rate-limited (HTTP 429). Retry or raise rate_limit_per_minute.`,
      429
    );
  }
  if (!evalRes.ok) {
    throw new GateInfraError(`evaluate HTTP ${evalRes.status}`, evalRes.status);
  }
  let evalBody;
  try {
    evalBody = await evalRes.json();
  } catch {
    throw new GateInfraError("failed to parse evaluate response as JSON");
  }
  const decision = evalBody["decision"] ?? "unknown";
  const permitToken = evalBody["permit_token"] ?? "";
  const evaluationId = evalBody["evaluation_id"] ?? "";
  const proofHash = evalBody["proof_hash"] ?? "";
  const riskScore = extractRiskScore(evalBody);
  if (decision !== "allow") {
    const reason = evalBody["deny_reason"] ?? evalBody["hold_reason"] ?? "";
    return { ok: false, decision, verified: false, permitToken, evaluationId, proofHash, riskScore, reason };
  }
  if (!permitToken) {
    throw new GateInfraError(
      `evaluate=allow but no permit_token \u2014 refusing to gate-open without a verifiable permit (evaluation: ${evaluationId})`
    );
  }
  const verify = await verifyOne({
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    actionType: params.actionType,
    actorId: params.actorId,
    permitToken
  });
  if (!verify.verified) {
    return {
      ok: false,
      decision: "allow",
      verified: false,
      permitToken,
      evaluationId,
      proofHash,
      riskScore,
      reason: `permit verification failed (outcome=${verify.outcome ?? "unknown"})`,
      verifyOutcome: verify.outcome
    };
  }
  return {
    ok: true,
    decision: "allow",
    verified: true,
    permitToken,
    evaluationId,
    proofHash,
    riskScore,
    verifyOutcome: verify.outcome ?? "verified"
  };
}
function extractRiskScore(result) {
  const risk = result["risk"];
  if (risk && typeof risk === "object" && "score" in risk) {
    const score = risk.score;
    if (typeof score === "number")
      return String(score);
  }
  const flat = result["risk_score"];
  if (typeof flat === "number")
    return String(flat);
  return "";
}

// src/batch.ts
async function evaluateMany(apiUrl, apiKey, items, v2Batch) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };
  let decisions;
  let batchId;
  if (v2Batch) {
    const r = await fetch(`${apiUrl}/v1/evaluate/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items })
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
        body: JSON.stringify(item)
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
        return { ...d, verified: d.decision === "allow" ? false : void 0 };
      }
      const item = items[i];
      const result = await verifyOne({
        apiUrl,
        apiKey,
        actionType: item.action,
        actorId: item.actor,
        permitToken: d.permitToken,
        verifyPath: "/v1/verify-permit"
      });
      return { ...d, verified: result.verified, verifyOutcome: result.outcome };
    })
  );
  return { decisions: verified, batchId };
}

// src/inputs.ts
function parseInputs(env) {
  const apiKey = required(env, "INPUT_API-KEY");
  const apiUrl = env["INPUT_API-URL"] || "https://api.atlasent.io";
  const failOnDeny = (env["INPUT_FAIL-ON-DENY"] || "true") === "true";
  const evaluationsRaw = env["INPUT_EVALUATIONS"];
  if (evaluationsRaw && evaluationsRaw.trim()) {
    const parsed = JSON.parse(evaluationsRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        "`evaluations` must be a non-empty JSON array of evaluation requests"
      );
    }
    return {
      apiKey,
      apiUrl,
      failOnDeny,
      evaluations: parsed,
      waitForId: env["INPUT_WAIT-FOR-ID"] || void 0,
      waitTimeoutMs: parseInt(env["INPUT_WAIT-TIMEOUT-MS"] || "600000", 10)
    };
  }
  const action = required(env, "INPUT_ACTION");
  const actor = env["INPUT_ACTOR"] || env["GITHUB_ACTOR"] || "unknown";
  const environment = env["INPUT_ENVIRONMENT"];
  const contextRaw = env["INPUT_CONTEXT"] || "{}";
  const context = JSON.parse(contextRaw);
  return {
    apiKey,
    apiUrl,
    failOnDeny,
    single: { action, actor, environment, context },
    waitForId: env["INPUT_WAIT-FOR-ID"] || void 0,
    waitTimeoutMs: parseInt(env["INPUT_WAIT-TIMEOUT-MS"] || "600000", 10)
  };
}
function required(env, key) {
  const v = env[key];
  if (!v) {
    throw new Error(`Missing required input: ${key.replace("INPUT_", "").toLowerCase()}`);
  }
  return v;
}

// src/stream.ts
var POLL_INTERVAL_MS = 5e3;
var SSE_LINE = /^data: (.+)$/;
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
      accept: "text/event-stream"
    },
    body: JSON.stringify({ evaluationId: opts.evaluationId }),
    signal: opts.signal
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
    if (done)
      break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        const m = SSE_LINE.exec(line);
        if (!m)
          continue;
        const event = JSON.parse(m[1]);
        if (event.decision === "allow" || event.decision === "deny") {
          return event;
        }
      }
    }
  }
  throw new Error(
    `atlasent stream timeout after ${opts.timeoutMs}ms for ${opts.evaluationId}`
  );
}
async function waitViaPolling(opts) {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(
      `${opts.apiUrl}/v1/evaluate/${encodeURIComponent(opts.evaluationId)}`,
      {
        headers: { authorization: `Bearer ${opts.apiKey}` },
        signal: opts.signal
      }
    );
    if (r.ok) {
      const decision = await r.json();
      if (decision.decision === "allow" || decision.decision === "deny") {
        return decision;
      }
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(
    `atlasent poll timeout after ${opts.timeoutMs}ms for ${opts.evaluationId}`
  );
}

// src/v21.ts
async function runV21(env, flags) {
  const inputs = parseInputs(env);
  const items = inputs.evaluations ?? [inputs.single];
  const batch = await evaluateMany(
    inputs.apiUrl,
    inputs.apiKey,
    items,
    flags.v2Batch
  );
  let decisions = batch.decisions;
  if (inputs.waitForId) {
    const idx = decisions.findIndex(
      (d) => d.id === inputs.waitForId && (d.decision === "hold" || d.decision === "escalate")
    );
    if (idx >= 0) {
      const terminal = await waitForTerminalDecision({
        apiUrl: inputs.apiUrl,
        apiKey: inputs.apiKey,
        evaluationId: inputs.waitForId,
        timeoutMs: inputs.waitTimeoutMs ?? 6e5,
        v2Streaming: flags.v2Streaming
      });
      decisions = [...decisions];
      decisions[idx] = terminal;
    }
  }
  const failed = inputs.failOnDeny && decisions.some((d) => d.decision === "deny");
  return { decisions, failed, batchId: batch.batchId };
}

// src/index.ts
function getInput(name, required2 = false) {
  const envKey = `INPUT_${name.replace(/-/g, "_").toUpperCase()}`;
  const val = (process.env[envKey] ?? "").trim();
  if (required2 && !val) {
    setFailed(`Input required and not supplied: ${name}`);
  }
  return val;
}
function setOutput(name, value) {
  const outputFile = process.env["GITHUB_OUTPUT"];
  if (outputFile) {
    const fs = require("node:fs");
    fs.appendFileSync(outputFile, `${name}=${value}
`);
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
    pr_number: process.env["GITHUB_REF"]?.match(/^refs\/pull\/(\d+)\//)?.[1],
    server_url: process.env["GITHUB_SERVER_URL"] ?? "https://github.com"
  };
}
function resolveEnvironment(explicit, ref, apiKey) {
  if (explicit)
    return explicit;
  if (apiKey.startsWith("ask_test_"))
    return "test";
  if (apiKey.startsWith("ask_live_"))
    return "live";
  const branch = ref.replace("refs/heads/", "");
  return branch === "main" || branch === "master" ? "live" : "test";
}
async function run() {
  const apiKey = getInput("api-key", true);
  const apiUrl = getInput("api-url") || "https://ihghhasvxtltlbizvkqy.supabase.co/functions/v1";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  maskValue(apiKey);
  const evaluationsRaw = getInput("evaluations");
  if (evaluationsRaw) {
    const waitForId = getInput("wait-for-id") || void 0;
    const waitTimeoutMs = parseInt(getInput("wait-timeout-ms") || "600000", 10);
    const v2Batch = getInput("v2-batch") === "true";
    const v2Streaming = getInput("v2-streaming") === "true";
    let result2;
    try {
      result2 = await runV21(
        {
          "INPUT_API-KEY": apiKey,
          "INPUT_API-URL": apiUrl,
          "INPUT_FAIL-ON-DENY": failOnDeny ? "true" : "false",
          INPUT_EVALUATIONS: evaluationsRaw,
          "INPUT_WAIT-FOR-ID": waitForId,
          "INPUT_WAIT-TIMEOUT-MS": String(waitTimeoutMs)
        },
        { v2Batch, v2Streaming }
      );
    } catch (err) {
      const msg = err instanceof GateInfraError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      setOutput("verified", "false");
      setFailed(`AtlaSent Gate (batch): ${msg}. Deploy blocked (fail-closed).`);
      return;
    }
    const decisionsJson = JSON.stringify(
      result2.decisions.map((d) => ({
        decision: d.decision,
        verified: d.verified ?? false,
        evaluationId: d.id ?? "",
        permitToken: d.permitToken ? "(masked)" : "",
        reasons: d.reasons ?? [],
        verifyOutcome: d.verifyOutcome ?? ""
      }))
    );
    const allVerified = result2.decisions.every(
      (d) => d.decision !== "allow" || d.verified === true
    );
    setOutput("batch-id", result2.batchId);
    setOutput("decisions", decisionsJson);
    setOutput("verified", allVerified ? "true" : "false");
    if (result2.failed) {
      setFailed(
        `AtlaSent Gate: one or more evaluations denied. See 'decisions' output for details.`
      );
      return;
    }
    if (!allVerified) {
      setFailed(
        `AtlaSent Gate: one or more allow decisions failed permit verification. Deploy blocked.`
      );
      return;
    }
    info(`AtlaSent Gate: all ${result2.decisions.length} evaluation(s) allowed and verified`);
    info(`  Batch ID: ${result2.batchId}`);
    return;
  }
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id");
  const explicitEnv = getInput("environment");
  let extraContext = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON \u2014 ignoring");
  }
  const gh = getGitHubContext();
  const environment = resolveEnvironment(explicitEnv, gh.ref, apiKey);
  const payload = {
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
      ...targetId ? { target_id: targetId } : {},
      ...extraContext
    }
  };
  if (targetId)
    payload["target_id"] = targetId;
  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment` + (targetId ? ` (target=${targetId})` : "")
  );
  let result;
  try {
    result = await runGate({
      apiUrl,
      apiKey,
      actionType,
      actorId: `github:${actor}`,
      payload
    });
  } catch (err) {
    const msg = err instanceof GateInfraError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    setOutput("decision", "error");
    setOutput("verified", "false");
    setFailed(
      `AtlaSent Gate: ${msg}. Deploy blocked \u2014 the gate cannot confirm authorization (fail-closed).`
    );
    return;
  }
  if (result.permitToken)
    maskValue(result.permitToken);
  if (result.proofHash)
    maskValue(result.proofHash);
  setOutput("decision", result.decision);
  setOutput("permit-token", result.permitToken);
  setOutput("evaluation-id", result.evaluationId);
  setOutput("proof-hash", result.proofHash);
  setOutput("risk-score", result.riskScore);
  setOutput("verified", result.verified ? "true" : "false");
  if (result.ok) {
    info(`Authorization GRANTED (evaluate + verify)`);
    info(`  Permit token: (set as 'permit-token' output, masked in logs)`);
    info(`  Proof hash:   (set as 'proof-hash' output, masked in logs)`);
    info(`  Evaluation:   ${result.evaluationId}`);
    if (result.riskScore)
      info(`  Risk score:   ${result.riskScore}`);
    info(`  Verify:       ${result.verifyOutcome}`);
    return;
  }
  if (result.decision === "allow") {
    setFailed(
      `Permit verification failed (outcome=${result.verifyOutcome ?? "unknown"}). Deploy blocked. This typically means the permit was already consumed by an earlier verify, or it expired.`
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
        setFailed("Authorization ESCALATED \u2014 manual review required");
      } else {
        warning("Authorization ESCALATED \u2014 manual review required");
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
