"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
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

// packages/enforce/dist/transport.js
var require_transport = __commonJS({
  "packages/enforce/dist/transport.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.post = post;
    var node_https_1 = __importDefault(require("node:https"));
    var node_http_1 = __importDefault(require("node:http"));
    function post(url, body, headers) {
      return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === "https:" ? node_https_1.default : node_http_1.default;
        const req = transport.request({
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
        }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Request timed out after 30s"));
        });
        req.write(body);
        req.end();
      });
    }
  }
});

// packages/enforce/dist/index.js
var require_dist = __commonJS({
  "packages/enforce/dist/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.EnforceError = void 0;
    exports2.evaluate = evaluate2;
    exports2.verify = verify;
    exports2.enforce = enforce;
    var transport_1 = require_transport();
    var DEFAULT_API_URL = "https://api.atlasent.io";
    var EnforceError2 = class extends Error {
      phase;
      decision;
      constructor(message, phase, decision = null) {
        super(message);
        this.name = "EnforceError";
        this.phase = phase;
        this.decision = decision;
      }
    };
    exports2.EnforceError = EnforceError2;
    async function evaluate2(config) {
      const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
      const payload = {
        action_type: config.action,
        actor_id: config.actor,
        context: {
          ...config.environment ? { environment: config.environment } : {},
          ...config.targetId ? { target_id: config.targetId } : {},
          ...config.context
        }
      };
      if (config.targetId)
        payload["target_id"] = config.targetId;
      let status;
      let body;
      try {
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1/evaluate`, JSON.stringify(payload), {
          Authorization: `Bearer ${config.apiKey}`
        }));
      } catch (err) {
        throw new EnforceError2(`AtlaSent API unreachable: ${err instanceof Error ? err.message : String(err)}`, "evaluate");
      }
      if (status >= 500) {
        throw new EnforceError2(`Infrastructure failure (HTTP ${status})`, "evaluate");
      }
      if (status === 401 || status === 403) {
        throw new EnforceError2(`Authentication failed (HTTP ${status})`, "evaluate");
      }
      if (status === 429) {
        throw new EnforceError2("Rate limited (HTTP 429)", "evaluate");
      }
      if (status < 200 || status >= 300) {
        throw new EnforceError2(`Unexpected response (HTTP ${status})`, "evaluate");
      }
      let raw;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new EnforceError2("Non-JSON response from AtlaSent API", "evaluate");
      }
      return mapDecision(raw);
    }
    function verify(decision) {
      switch (decision.decision) {
        case "allow":
          return;
        case "deny":
          throw new EnforceError2(`Denied: ${decision.denyReason ?? "no reason provided"}`, "verify", decision);
        case "hold":
          throw new EnforceError2(`On hold: ${decision.holdReason ?? "awaiting approval"}`, "verify", decision);
        case "escalate":
          throw new EnforceError2("Escalated \u2014 manual review required", "verify", decision);
        default:
          throw new EnforceError2(`Unknown decision: ${String(decision.decision)}`, "verify", decision);
      }
    }
    async function enforce(config, fn) {
      const decision = await evaluate2(config);
      verify(decision);
      const result = await fn();
      return { result, decision };
    }
    function mapDecision(raw) {
      return {
        decision: raw["decision"],
        evaluationId: raw["evaluation_id"],
        permitToken: raw["permit_token"],
        proofHash: raw["proof_hash"],
        riskScore: extractRiskScore(raw),
        denyReason: raw["deny_reason"],
        holdReason: raw["hold_reason"]
      };
    }
    function extractRiskScore(raw) {
      const risk = raw["risk"];
      if (risk && typeof risk === "object" && "score" in risk) {
        const score = risk.score;
        if (typeof score === "number")
          return score;
      }
      const flat = raw["risk_score"];
      if (typeof flat === "number")
        return flat;
      return void 0;
    }
  }
});

// src/index.ts
var import_enforce = __toESM(require_dist());

// src/batch.ts
async function evaluateMany(apiUrl, apiKey, items, v2Batch) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };
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
    return { decisions: data.results, batchId: data.batchId };
  }
  const decisions = [];
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
  return { decisions, batchId: `loop-${Date.now()}` };
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
    run_url: `${server_url}/${repository}/actions/runs/${run_id}`
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
function fromEnforceDecision(d) {
  return {
    decision: d.decision,
    evaluationId: d.evaluationId ?? "",
    permitToken: d.permitToken ?? "",
    proofHash: d.proofHash ?? "",
    riskScore: d.riskScore !== void 0 ? String(d.riskScore) : "",
    denyReason: d.denyReason,
    holdReason: d.holdReason
  };
}
function fromLocalDecision(d) {
  return {
    decision: d.decision,
    evaluationId: d.id ?? "",
    permitToken: d.permitToken ?? "",
    proofHash: d.proofHash ?? "",
    riskScore: "",
    denyReason: d.reasons?.[0],
    holdReason: d.reasons?.[0]
  };
}
function applyResult(result, failOnDeny) {
  const { decision, evaluationId, permitToken, proofHash, riskScore } = result;
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
    case "allow":
      info("Authorization GRANTED");
      info("  Permit token: (set as 'permit-token' output, masked in logs)");
      info("  Proof hash:   (set as 'proof-hash' output, masked in logs)");
      info(`  Evaluation:   ${evaluationId}`);
      if (riskScore)
        info(`  Risk score:   ${riskScore}`);
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
        setFailed("Authorization ESCALATED \u2014 manual review required");
      } else {
        warning("Authorization ESCALATED \u2014 manual review required");
      }
      break;
    default:
      warning(`Unexpected decision: ${decision}`);
      if (failOnDeny)
        setFailed(`Unexpected decision from AtlaSent: ${decision}`);
  }
}
function aggregateDecision(decisions) {
  if (decisions.some((d) => d.decision === "deny"))
    return "deny";
  if (decisions.some((d) => d.decision === "hold"))
    return "hold";
  if (decisions.some((d) => d.decision === "escalate"))
    return "escalate";
  return "allow";
}
async function runSingle(opts) {
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id") || void 0;
  const explicitEnv = getInput("environment");
  let extraContext = {};
  try {
    extraContext = JSON.parse(getInput("context") || "{}");
  } catch {
    warning("Could not parse 'context' input as JSON \u2014 ignoring");
  }
  const gh = getGitHubContext();
  const environment = resolveEnvironment(explicitEnv, gh.ref, opts.apiKey);
  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment` + (targetId ? ` (target=${targetId})` : "")
  );
  let enforceDecision;
  try {
    enforceDecision = await (0, import_enforce.evaluate)({
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
        ...extraContext
      }
    });
  } catch (err) {
    setOutput("decision", "error");
    setFailed(err instanceof import_enforce.EnforceError ? err.message : String(err));
  }
  if (opts.waitForId && enforceDecision.evaluationId === opts.waitForId && (enforceDecision.decision === "hold" || enforceDecision.decision === "escalate")) {
    info(`Waiting for terminal decision on evaluation ${opts.waitForId}...`);
    const terminal = await waitForTerminalDecision({
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      evaluationId: opts.waitForId,
      timeoutMs: opts.waitTimeoutMs,
      v2Streaming: opts.v2Streaming
    });
    applyResult(fromLocalDecision(terminal), opts.failOnDeny);
    return;
  }
  applyResult(fromEnforceDecision(enforceDecision), opts.failOnDeny);
}
async function runBatch(opts) {
  let items;
  try {
    const parsed = JSON.parse(opts.evaluationsRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("must be a non-empty JSON array");
    }
    items = parsed;
  } catch (err) {
    setOutput("decision", "error");
    setFailed(
      `Invalid 'evaluations' input: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  info(`AtlaSent Gate: evaluating ${items.length} action(s) in batch`);
  let { decisions } = await evaluateMany(opts.apiUrl, opts.apiKey, items, opts.v2Batch);
  if (opts.waitForId) {
    const idx = decisions.findIndex(
      (d) => d.id === opts.waitForId && (d.decision === "hold" || d.decision === "escalate")
    );
    if (idx >= 0) {
      info(`Waiting for terminal decision on evaluation ${opts.waitForId}...`);
      const terminal = await waitForTerminalDecision({
        apiUrl: opts.apiUrl,
        apiKey: opts.apiKey,
        evaluationId: opts.waitForId,
        timeoutMs: opts.waitTimeoutMs,
        v2Streaming: opts.v2Streaming
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
    const counts = decisions.reduce((acc, d) => {
      acc[d.decision] = (acc[d.decision] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
    if (opts.failOnDeny) {
      setFailed(`Batch gate not fully authorized: ${summary}`);
    } else {
      warning(`Batch gate not fully authorized: ${summary}`);
    }
  }
}
async function run() {
  const apiKey = getInput("api-key", true);
  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  const evaluationsRaw = getInput("evaluations");
  const waitForId = getInput("wait-for-id") || void 0;
  const waitTimeoutMs = parseInt(getInput("wait-timeout-ms") || "600000", 10);
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
