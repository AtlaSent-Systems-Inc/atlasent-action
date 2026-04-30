"use strict";

// src/gate.ts
var GateInfraError = class extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.name = "GateInfraError";
  }
};
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
  let verifyRes;
  try {
    verifyRes = await fetch(`${params.apiUrl}/v1-verify-permit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        permit_token: permitToken,
        action_type: params.actionType,
        actor_id: params.actorId
      })
    });
  } catch (err) {
    throw new GateInfraError(
      `verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!verifyRes.ok) {
    throw new GateInfraError(
      `verify-permit HTTP ${verifyRes.status}`,
      verifyRes.status
    );
  }
  let verifyBody;
  try {
    verifyBody = await verifyRes.json();
  } catch {
    throw new GateInfraError("failed to parse verify-permit response as JSON");
  }
  if (verifyBody.verified !== true) {
    return {
      ok: false,
      decision: "allow",
      verified: false,
      permitToken,
      evaluationId,
      proofHash,
      riskScore,
      reason: `permit verification failed (outcome=${verifyBody.outcome ?? "unknown"})`,
      verifyOutcome: verifyBody.outcome
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
    verifyOutcome: verifyBody.outcome ?? "verified"
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

// src/index.ts
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
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id");
  const explicitEnv = getInput("environment");
  const apiUrl = getInput("api-url") || "https://ihghhasvxtltlbizvkqy.supabase.co/functions/v1";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  let extraContext = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON \u2014 ignoring");
  }
  maskValue(apiKey);
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
