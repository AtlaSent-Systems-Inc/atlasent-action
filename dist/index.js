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
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

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
          res.on("error", reject);
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
    exports2.evaluate = evaluate;
    exports2.verify = verify;
    exports2.verifyPermit = verifyPermit3;
    exports2.enforce = enforce2;
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
    async function evaluate(config) {
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
    async function verifyPermit3(config, decision) {
      if (!decision.permitToken) {
        throw new EnforceError2("evaluate returned allow but no permit_token \u2014 refusing to execute without verifiable permit", "verify-permit", decision);
      }
      const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
      let status;
      let body;
      try {
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1/verify-permit`, JSON.stringify({
          permit_token: decision.permitToken,
          action_type: config.action,
          actor_id: config.actor
        }), { Authorization: `Bearer ${config.apiKey}` }));
      } catch (err) {
        throw new EnforceError2(`verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`, "verify-permit", decision);
      }
      if (status >= 500) {
        throw new EnforceError2(`verify-permit infrastructure failure (HTTP ${status})`, "verify-permit", decision);
      }
      if (status < 200 || status >= 300) {
        throw new EnforceError2(`verify-permit failed (HTTP ${status})`, "verify-permit", decision);
      }
      let raw;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new EnforceError2("Non-JSON response from verify-permit", "verify-permit", decision);
      }
      if (raw.verified !== true) {
        throw new EnforceError2(`Permit verification failed (outcome=${raw.outcome ?? "unknown"})`, "verify-permit", decision);
      }
      return { verified: true, outcome: raw.outcome };
    }
    async function enforce2(config, fn) {
      const decision = await evaluate(config);
      verify(decision);
      const vp = await verifyPermit3(config, decision);
      const result = await fn();
      return { result, decision, verifyOutcome: vp.outcome };
    }
    function mapDecision(raw) {
      return {
        decision: raw["decision"],
        evaluationId: raw["evaluation_id"],
        permitToken: raw["permit_token"],
        proofHash: raw["proof_hash"],
        riskScore: extractRiskScore(raw),
        denyReason: raw["deny_reason"],
        holdReason: raw["hold_reason"],
        chainEntry: raw["chain_entry"] ?? null,
        snapshot: raw["snapshot"] ?? null,
        auditHash: raw["audit_hash"]
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
var src_exports = {};
__export(src_exports, {
  run: () => run
});
module.exports = __toCommonJS(src_exports);
var import_enforce3 = __toESM(require_dist());

// src/gate.ts
var GateInfraError = class extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.name = "GateInfraError";
  }
};

// src/v21.ts
var import_enforce2 = __toESM(require_dist());

// src/batch.ts
var import_enforce = __toESM(require_dist());
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
      const enforceConfig = { apiKey, apiUrl, action: item.action, actor: item.actor };
      const enforceDecision = { decision: "allow", permitToken: d.permitToken };
      const result = await (0, import_enforce.verifyPermit)(enforceConfig, enforceDecision);
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
    let parsed;
    try {
      parsed = JSON.parse(evaluationsRaw);
    } catch {
      throw new Error("`evaluations` is not valid JSON \u2014 expected a JSON array of evaluation requests");
    }
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
  let context = {};
  try {
    context = JSON.parse(contextRaw);
  } catch {
    throw new Error("`context` is not valid JSON \u2014 expected a JSON object");
  }
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
    try {
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
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        throw err;
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
      if (terminal.decision === "allow") {
        const item = items[idx];
        const vr = terminal.permitToken ? await (0, import_enforce2.verifyPermit)(
          { apiKey: inputs.apiKey, apiUrl: inputs.apiUrl, action: item.action, actor: item.actor },
          { decision: "allow", permitToken: terminal.permitToken }
        ) : { verified: false, outcome: void 0 };
        decisions[idx] = { ...terminal, verified: vr.verified, verifyOutcome: vr.outcome };
      } else {
        decisions[idx] = terminal;
      }
    }
  }
  const failed = inputs.failOnDeny && decisions.some((d) => d.decision === "deny" || d.decision === "hold" || d.decision === "escalate");
  return { decisions, failed, batchId: batch.batchId };
}

// src/financialGovernanceAdvisory.ts
var USD_EQUIVALENT_CURRENCIES = /* @__PURE__ */ new Set(["USD", "USDC", "USDT", "DAI"]);
var REGULATORY_ACTION_TYPES = /* @__PURE__ */ new Set(["wire_transfer", "trading_execution"]);
var TIER_LOW_MAX = 1e3;
var TIER_MEDIUM_MAX = 5e4;
var TIER_HIGH_MAX = 1e6;
function computeRiskScore(value, tier) {
  switch (tier) {
    case "non_financial":
      return 0;
    case "low":
      return Math.min(19, Math.round(value / TIER_LOW_MAX * 19));
    case "medium":
      return Math.min(49, 20 + Math.round((value - TIER_LOW_MAX) / (TIER_MEDIUM_MAX - TIER_LOW_MAX) * 29));
    case "high":
      return Math.min(79, 50 + Math.round((value - TIER_MEDIUM_MAX) / (TIER_HIGH_MAX - TIER_MEDIUM_MAX) * 29));
    case "critical":
      return Math.min(100, 80 + Math.round(Math.log10(value / TIER_HIGH_MAX) * 10));
  }
}
function assessFinancialGovernance(input) {
  const { actionType, actionValue, currency, actorId } = input;
  const isUsdEquivalent = USD_EQUIVALENT_CURRENCIES.has(currency.toUpperCase());
  if (!actionValue || actionValue <= 0 || !isUsdEquivalent) {
    return {
      adviceMode: "advisory",
      riskTier: "non_financial",
      riskScore: 0,
      evidenceRequired: false,
      signals: [],
      summary: `Financial governance advisory: no financial action detected (actor=${actorId})`
    };
  }
  let riskTier;
  if (actionValue < TIER_LOW_MAX) {
    riskTier = "low";
  } else if (actionValue < TIER_MEDIUM_MAX) {
    riskTier = "medium";
  } else if (actionValue < TIER_HIGH_MAX) {
    riskTier = "high";
  } else {
    riskTier = "critical";
  }
  const evidenceRequired = riskTier === "high" || riskTier === "critical";
  const riskScore = computeRiskScore(actionValue, riskTier);
  const signals = [];
  if (riskTier === "high" || riskTier === "critical") {
    signals.push(
      `High-value financial action ($${actionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}) \u2014 quorum approval recommended`
    );
  }
  if (evidenceRequired) {
    signals.push("Evidence bundle required for audit trail");
  }
  if (REGULATORY_ACTION_TYPES.has(actionType)) {
    signals.push(
      `Action type '${actionType}' has regulatory reporting implications`
    );
  }
  const summary = `Financial governance advisory: ${riskTier.toUpperCase()} risk | $${actionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency} | score=${riskScore} | evidenceRequired=${evidenceRequired} | actor=${actorId}`;
  return {
    adviceMode: "advisory",
    riskTier,
    riskScore,
    evidenceRequired,
    signals,
    summary
  };
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
function setDecisionOutputs(d) {
  if (d.permitToken)
    maskValue(d.permitToken);
  if (d.proofHash)
    maskValue(d.proofHash);
  setOutput("decision", d.decision);
  setOutput("permit-token", d.permitToken ?? "");
  setOutput("evaluation-id", d.evaluationId ?? "");
  setOutput("proof-hash", d.proofHash ?? "");
  setOutput("risk-score", d.riskScore !== void 0 ? String(d.riskScore) : "");
  setOutput("chain-entry", JSON.stringify(d.chainEntry ?? null));
  setOutput("snapshot", JSON.stringify(d.snapshot ?? null));
  setOutput("audit-hash", d.auditHash ?? "");
}
function appendToStepSummary(content) {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) {
    try {
      const fs = require("node:fs");
      fs.appendFileSync(summaryFile, content);
    } catch {
    }
  }
}
function emitFinancialGovernanceAdvisory(actionType, actor, orgId) {
  const governanceMode = getInput("financial-governance");
  if (governanceMode !== "advisory")
    return;
  const rawValue = getInput("financial-action-value");
  const currency = getInput("financial-action-currency") || "USD";
  const actionValue = rawValue ? parseFloat(rawValue) : null;
  const advisoryInput = {
    actionType,
    actionValue: actionValue !== null && !isNaN(actionValue) ? actionValue : null,
    currency,
    actorId: actor,
    orgId
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
    info(`  \u2022 ${signal}`);
  }
  const tierEmoji = {
    non_financial: "\u26AA",
    low: "\u{1F7E2}",
    medium: "\u{1F7E1}",
    high: "\u{1F7E0}",
    critical: "\u{1F534}"
  };
  const emoji = tierEmoji[advisory.riskTier] ?? "\u26AA";
  const signalLines = advisory.signals.length > 0 ? advisory.signals.map((s) => `- ${s}`).join("\n") : "- No advisory signals";
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
    actionValue !== null ? `| Action Value | $${actionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })} |` : `| Action Value | N/A |`,
    "",
    "### Advisory Signals",
    "",
    signalLines,
    "",
    "> **Advisory only** \u2014 this assessment is non-blocking and does not affect enforcement decisions.",
    ""
  ].join("\n");
  appendToStepSummary(summaryBlock);
}
async function run() {
  const apiKey = getInput("api-key", true);
  maskValue(apiKey);
  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  maskValue(apiKey);
  const evaluationsRaw = getInput("evaluations");
  if (evaluationsRaw) {
    const waitForId = getInput("wait-for-id") || void 0;
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
          "INPUT_WAIT-TIMEOUT-MS": String(waitTimeoutMs)
        },
        { v2Batch, v2Streaming }
      );
    } catch (err) {
      const msg = err instanceof import_enforce3.EnforceError || err instanceof GateInfraError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      setOutput("verified", "false");
      setOutput("decisions", "[]");
      setOutput("batch-id", "");
      setFailed(`AtlaSent Gate (batch): ${msg}. Deploy blocked (fail-closed).`);
      return;
    }
    const decisionsJson = JSON.stringify(
      result.decisions.map((d2) => ({
        decision: d2.decision,
        verified: d2.verified ?? false,
        evaluationId: d2.id ?? "",
        permitToken: d2.permitToken ? "(masked)" : "",
        reasons: d2.reasons ?? [],
        verifyOutcome: d2.verifyOutcome ?? ""
      }))
    );
    const allVerified = result.decisions.every(
      (d2) => d2.decision !== "allow" || d2.verified === true
    );
    setOutput("batch-id", result.batchId);
    setOutput("decisions", decisionsJson);
    setOutput("verified", allVerified ? "true" : "false");
    if (result.failed) {
      setFailed(
        `AtlaSent Gate: one or more evaluations were not allowed (deny/hold/escalate). See 'decisions' output for details.`
      );
      return;
    }
    if (!allVerified) {
      setFailed(
        `AtlaSent Gate: one or more allow decisions failed permit verification. Deploy blocked.`
      );
      return;
    }
    info(`AtlaSent Gate: all ${result.decisions.length} evaluation(s) allowed and verified`);
    info(`  Batch ID: ${result.batchId}`);
    return;
  }
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
  const environment = resolveEnvironment(explicitEnv, gh.ref, apiKey);
  const orgId = gh.repository.split("/")[0] ?? "unknown";
  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "github:${actor}" in ${environment} environment` + (targetId ? ` (target=${targetId})` : "")
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
      ...extraContext
    }
  };
  let enforceResult;
  try {
    enforceResult = await (0, import_enforce3.enforce)(config, async () => {
    });
  } catch (err) {
    if (err instanceof import_enforce3.EnforceError) {
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
            warning("Authorization ESCALATED \u2014 manual review required");
            break;
          default:
            warning(`Authorization ${err.decision?.decision ?? "unknown"}`);
        }
        return;
      }
      switch (err.phase) {
        case "evaluate":
          setFailed(
            `AtlaSent Gate: ${err.message}. Deploy blocked \u2014 the gate cannot confirm authorization (fail-closed).`
          );
          break;
        case "verify":
          switch (err.decision?.decision) {
            case "deny":
              setFailed(
                `Authorization DENIED: ${err.decision.denyReason ?? "no reason provided"}`
              );
              break;
            case "hold":
              setFailed(
                `Authorization on HOLD: ${err.decision.holdReason ?? "awaiting approval"}`
              );
              break;
            case "escalate":
              setFailed("Authorization ESCALATED \u2014 manual review required");
              break;
            default:
              setFailed(`Unexpected decision from AtlaSent: ${err.decision?.decision ?? "unknown"}`);
          }
          break;
        case "verify-permit":
          setFailed(
            `AtlaSent Gate: ${err.message}. Deploy blocked (fail-closed).`
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
    emitFinancialGovernanceAdvisory(actionType, actor, orgId);
    setFailed(
      `AtlaSent Gate: Unexpected error: ${err instanceof Error ? err.message : String(err)}`
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
  if (d.riskScore !== void 0)
    info(`  Risk score:   ${d.riskScore}`);
  info(`  Verify:       ${verifyOutcome ?? "verified"}`);
  emitFinancialGovernanceAdvisory(actionType, actor, orgId);
}
if (require.main === module) {
  run().catch((err) => {
    console.log(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  run
});
