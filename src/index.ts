// AtlaSent Gate Action — Zero-dependency GitHub Action entry point
// Reads GitHub Actions inputs via INPUT_* env vars and calls the AtlaSent evaluate endpoint.

import https from "node:https";
import http from "node:http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInput(name: string, required = false): string {
  // GitHub Actions sets inputs as env vars: INPUT_<UPPER_NAME> with hyphens replaced by underscores
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
  // Also log for older runners
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
// HTTP helper — zero-dependency POST using Node built-ins
// ---------------------------------------------------------------------------

interface HttpResponse {
  status: number;
  body: string;
}

function post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
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

// ---------------------------------------------------------------------------
// GitHub context from environment
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

// ---------------------------------------------------------------------------
// Determine environment
// ---------------------------------------------------------------------------

function resolveEnvironment(explicit: string, ref: string, apiKey: string): string {
  if (explicit) return explicit;
  // Infer from API key prefix
  if (apiKey.startsWith("ask_test_")) return "test";
  if (apiKey.startsWith("ask_live_")) return "live";
  // Infer from branch
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
  const explicitEnv = getInput("environment");
  const apiUrl = getInput("api-url") || "https://ihghhasvxtltlbizvkqy.supabase.co/functions/v1";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  let extraContext: Record<string, unknown> = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON — ignoring");
  }

  // Mask the API key so it never appears in logs
  maskValue(apiKey);

  // 2. Build context
  const gh = getGitHubContext();
  const environment = resolveEnvironment(explicitEnv, gh.ref, apiKey);
  const targetId = getInput("target-id") || gh.repository;

  const payload = {
    action_type: actionType,
    actor_id: `github:${actor}`,
    context: {
      environment,
      source: "github-action",
      target_id: targetId,
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

  info(`AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment`);

  // 3. Call the evaluate endpoint.
  // Infrastructure errors (network, timeout, 5xx, 401/403, 429) are
  // distinct from policy decisions. `fail-on-deny` governs whether a
  // legitimate deny/hold/escalate fails the job; it does NOT mean
  // "fail open on missing authorization." A security gate that
  // silently lets deploys through when its authority source is
  // unreachable is worse than no gate.
  let response: HttpResponse;
  try {
    response = await post(`${apiUrl}/v1-evaluate`, JSON.stringify(payload), {
      Authorization: `Bearer ${apiKey}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API unreachable: ${message}. The deploy is blocked because ` +
        `the authorization gate could not confirm a policy decision. ` +
        `Set ATLASENT_ALLOW_INFRA_BYPASS=1 to deliberately fail-open on ` +
        `transport errors (not recommended for production gates).`,
    );
    return;
  }

  // 4. Classify the HTTP status. Only 2xx is a policy decision; every
  // other class is an infrastructure state we must not confuse with
  // a decision.
  if (response.status >= 500) {
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API returned HTTP ${response.status} — infrastructure failure, ` +
        `not a policy decision. Deploy blocked. Body: ${response.body.slice(0, 300)}`,
    );
    return;
  }
  if (response.status === 401 || response.status === 403) {
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API auth failed (HTTP ${response.status}). Check your ` +
        `ATLASENT_API_KEY and the key's scopes. Body: ${response.body.slice(0, 300)}`,
    );
    return;
  }
  if (response.status === 429) {
    // Rate-limited — transient, but safer to block than silently
    // allow. Retries should be a caller-controlled workflow decision,
    // not an action-level fail-open.
    setOutput("decision", "error");
    setFailed(
      `AtlaSent API rate-limited this gate (HTTP 429). Deploy blocked. ` +
        `Retry the job or raise the key's rate_limit_per_minute.`,
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

  let result: {
    decision?: string;
    permit_token?: string;
    evaluation_id?: string;
    proof_hash?: string;
    deny_reason?: string;
    hold_reason?: string;
    risk?: { level?: string; score?: number; reasons?: string[] };
  };

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
  const riskScore = result.risk?.score ?? null;

  // Mask the permit token + proof hash so they don't appear verbatim
  // in action logs. The API key already gets masked at line 162;
  // extend the same treatment to derived secrets. Permit tokens are
  // short-lived and single-use but customer CI log retention can be
  // long — treat as sensitive at rest.
  if (permitToken) maskValue(permitToken);
  if (proofHash) maskValue(proofHash);

  // 5. Set outputs (GitHub masks them in console echoes because of
  // the maskValue() calls above).
  setOutput("decision", decision);
  setOutput("permit-token", permitToken);
  setOutput("evaluation-id", evaluationId);
  setOutput("proof-hash", proofHash);
  setOutput("risk-score", riskScore !== null ? String(riskScore) : "");

  // 6. Handle decision
  switch (decision) {
    case "allow":
      info(`Authorization GRANTED`);
      info(`  Permit token: (set as 'permit-token' output, masked in logs)`);
      info(`  Proof hash:   (set as 'proof-hash' output, masked in logs)`);
      info(`  Evaluation:   ${evaluationId}`);
      info(`  Risk score:   ${riskScore ?? "n/a"}`);
      break;

    case "deny":
      if (failOnDeny) {
        setFailed(`Authorization DENIED: ${result!.deny_reason ?? "no reason provided"}`);
      } else {
        warning(`Authorization DENIED: ${result!.deny_reason ?? "no reason provided"}`);
      }
      break;

    case "hold":
      if (failOnDeny) {
        setFailed(`Authorization on HOLD: ${result!.hold_reason ?? "awaiting approval"}`);
      } else {
        warning(`Authorization on HOLD: ${result!.hold_reason ?? "awaiting approval"}`);
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
      if (failOnDeny) {
        setFailed(`Unexpected decision from AtlaSent: ${decision}`);
      }
  }
}

run().catch((err) => {
  console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
