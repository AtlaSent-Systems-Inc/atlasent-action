"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_node_https = __toESM(require("node:https"));
var import_node_http = __toESM(require("node:http"));
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
function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? import_node_https.default : import_node_http.default;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers
        },
        timeout: 3e4
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8")
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out after 30 seconds"));
    });
    req.write(body);
    req.end();
  });
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
      // target_id is also threaded into context so policies that read
      // context.target_id (rather than the top-level target_id) match.
      ...targetId ? { target_id: targetId } : {},
      ...extraContext
    }
  };
  if (targetId)
    payload["target_id"] = targetId;
  info(`AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment${targetId ? ` (target=${targetId})` : ""}`);
  let response;
  try {
    response = await post(`${apiUrl}/v1-evaluate`, JSON.stringify(payload), {
      Authorization: `Bearer ${apiKey}`
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API unreachable: ${message}. The deploy is blocked because the authorization gate could not confirm a policy decision. Set ATLASENT_ALLOW_INFRA_BYPASS=1 to deliberately fail-open on transport errors (not recommended for production gates).`
    );
    return;
  }
  if (response.status >= 500) {
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API returned HTTP ${response.status} \u2014 infrastructure failure, not a policy decision. Deploy blocked. Body: ${response.body.slice(0, 300)}`
    );
    return;
  }
  if (response.status === 401 || response.status === 403) {
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API auth failed (HTTP ${response.status}). Check your ATLASENT_API_KEY and the key's scopes. Body: ${response.body.slice(0, 300)}`
    );
    return;
  }
  if (response.status === 429) {
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API rate-limited this gate (HTTP 429). Deploy blocked. Retry the job or raise the key's rate_limit_per_minute.`
    );
    return;
  }
  if (response.status < 200 || response.status >= 300) {
    const msg = `AtlaSent API returned HTTP ${response.status}: ${response.body.slice(0, 300)}`;
    if (failOnDeny) {
      setFailed(msg);
      return;
    }
    warning(msg);
    setOutput("decision", "error");
    return;
  }
  let result;
  try {
    result = JSON.parse(response.body);
  } catch {
    setFailed(`Failed to parse AtlaSent response: ${response.body.slice(0, 300)}`);
    return;
  }
  const decision = result.decision ?? "unknown";
  const permitToken = result.permit_token ?? "";
  const evaluationId = result.evaluation_id ?? "";
  const proofHash = result.proof_hash ?? "";
  const riskScore = extractRiskScore(result);
  if (permitToken)
    maskValue(permitToken);
  if (proofHash)
    maskValue(proofHash);
  setOutput("decision", decision);
  setOutput("permit-token", permitToken);
  setOutput("evaluation-id", evaluationId);
  setOutput("proof-hash", proofHash);
  setOutput("risk-score", riskScore);
  switch (decision) {
    case "allow": {
      if (!permitToken) {
        setOutput("verified", "false");
        setFailed(
          `AtlaSent returned decision=allow but no permit_token \u2014 refusing to gate-open without a verifiable permit. Evaluation: ${evaluationId}`
        );
        return;
      }
      let verifyResp;
      try {
        verifyResp = await post(
          `${apiUrl}/v1-verify-permit`,
          JSON.stringify({
            permit_token: permitToken,
            action_type: actionType,
            actor_id: `github:${actor}`
          }),
          { Authorization: `Bearer ${apiKey}` }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setOutput("verified", "false");
        setFailed(
          `AtlaSent verify-permit unreachable: ${message}. Deploy blocked \u2014 the gate cannot confirm the permit was authorized for use here.`
        );
        return;
      }
      if (verifyResp.status < 200 || verifyResp.status >= 300) {
        setOutput("verified", "false");
        setFailed(
          `AtlaSent verify-permit returned HTTP ${verifyResp.status}. Deploy blocked. Body: ${verifyResp.body.slice(0, 300)}`
        );
        return;
      }
      let verify;
      try {
        verify = JSON.parse(verifyResp.body);
      } catch {
        setOutput("verified", "false");
        setFailed(`Failed to parse verify-permit response: ${verifyResp.body.slice(0, 300)}`);
        return;
      }
      if (verify.verified !== true) {
        setOutput("verified", "false");
        setFailed(
          `Permit verification failed (outcome=${verify.outcome ?? "unknown"}). Deploy blocked. This typically means the permit was already consumed by an earlier verify, or it expired.`
        );
        return;
      }
      setOutput("verified", "true");
      info(`Authorization GRANTED (evaluate + verify)`);
      info(`  Permit token: (set as 'permit-token' output, masked in logs)`);
      info(`  Proof hash:   (set as 'proof-hash' output, masked in logs)`);
      info(`  Evaluation:   ${evaluationId}`);
      info(`  Verify:       ${verify.outcome ?? "verified"}`);
      if (riskScore)
        info(`  Risk score:   ${riskScore}`);
      break;
    }
    case "deny":
      setOutput("verified", "false");
      if (failOnDeny) {
        setFailed(`Authorization DENIED: ${result.deny_reason ?? "no reason provided"}`);
      } else {
        warning(`Authorization DENIED: ${result.deny_reason ?? "no reason provided"}`);
      }
      break;
    case "hold":
      setOutput("verified", "false");
      if (failOnDeny) {
        setFailed(`Authorization on HOLD: ${result.hold_reason ?? "awaiting approval"}`);
      } else {
        warning(`Authorization on HOLD: ${result.hold_reason ?? "awaiting approval"}`);
      }
      break;
    case "escalate":
      setOutput("verified", "false");
      if (failOnDeny) {
        setFailed("Authorization ESCALATED \u2014 manual review required");
      } else {
        warning("Authorization ESCALATED \u2014 manual review required");
      }
      break;
    default:
      setOutput("verified", "false");
      warning(`Unexpected decision: ${decision}`);
      if (failOnDeny) {
        setFailed(`Unexpected decision from AtlaSent: ${decision}`);
      }
  }
}
run().catch((err) => {
  console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
