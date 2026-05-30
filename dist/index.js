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
      return new Promise((resolve3, reject) => {
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
          res.on("end", () => resolve3({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
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
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1-evaluate`, JSON.stringify(payload), {
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
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1-verify-permit`, JSON.stringify({
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
var BATCH_MAX_ITEMS = 100;
var BATCH_MIN_ITEMS = 2;
async function evaluateMany(apiUrl, apiKey, items, v2Batch) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };
  let decisions;
  let batchId;
  const shouldUseBatch = v2Batch && items.length >= BATCH_MIN_ITEMS;
  if (shouldUseBatch) {
    try {
      const out = await postBatchChunked(apiUrl, headers, items);
      decisions = out.decisions;
      batchId = out.batchId;
    } catch (err) {
      if (err instanceof BatchEndpointDisabled) {
        const out = await loopEvaluate(apiUrl, headers, items);
        decisions = out.decisions;
        batchId = out.batchId;
      } else {
        throw err;
      }
    }
  } else {
    const out = await loopEvaluate(apiUrl, headers, items);
    decisions = out.decisions;
    batchId = out.batchId;
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
var BatchEndpointDisabled = class extends Error {
  constructor() {
    super("v1-evaluate/batch disabled for this tenant (404)");
    this.name = "BatchEndpointDisabled";
  }
};
async function postBatchChunked(apiUrl, headers, items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += BATCH_MAX_ITEMS) {
    chunks.push(items.slice(i, i + BATCH_MAX_ITEMS));
  }
  const all = [];
  let firstBatchId = "";
  for (let c = 0; c < chunks.length; c++) {
    const r = await fetch(`${apiUrl}/v1-evaluate/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: chunks[c] })
    });
    if (r.status === 404) {
      throw new BatchEndpointDisabled();
    }
    if (!r.ok) {
      throw new Error(`atlasent /v1-evaluate/batch ${r.status}`);
    }
    const data = await r.json();
    all.push(...data.results);
    if (c === 0)
      firstBatchId = data.batchId;
  }
  const batchId = chunks.length > 1 ? `chunked-${Date.now()}` : firstBatchId;
  return { decisions: all, batchId };
}
async function loopEvaluate(apiUrl, headers, items) {
  const decisions = [];
  for (const item of items) {
    const r = await fetch(`${apiUrl}/v1-evaluate`, {
      method: "POST",
      headers,
      body: JSON.stringify(item)
    });
    if (!r.ok) {
      throw new Error(`atlasent /v1-evaluate ${r.status}`);
    }
    decisions.push(await r.json());
  }
  return { decisions, batchId: `loop-${Date.now()}` };
}

// src/canonicalAction.ts
var PRODUCTION_DEPLOY_ACTION = "production.deploy";
var LEGACY_PRODUCTION_DEPLOY_ALIAS = "deployment.production";
function normalizeProtectedAction(raw) {
  if (raw === LEGACY_PRODUCTION_DEPLOY_ALIAS) {
    return { canonical: PRODUCTION_DEPLOY_ACTION, wasLegacyAlias: true };
  }
  return { canonical: raw, wasLegacyAlias: false };
}
var ACTION_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$/;
function isValidActionType(raw) {
  return ACTION_TYPE_PATTERN.test(raw);
}
function assertValidActionType(raw) {
  const { canonical } = normalizeProtectedAction(raw);
  if (!isValidActionType(canonical)) {
    throw new Error(
      `Invalid action type "${raw}". Expected dot-separated lowercase identifiers, 2\u20134 segments (e.g. "production.deploy", "database.migration.apply").`
    );
  }
}

// src/inputs.ts
function parseInputs(env) {
  const apiKey = required(env, "ATLASENT_API_KEY");
  const apiUrl = env["INPUT_API-URL"] || env["ATLASENT_BASE_URL"] || "https://api.atlasent.io";
  const failOnDeny = (env["INPUT_FAIL-ON-DENY"] || "true") === "true";
  const policySyncEnabled = (env["INPUT_POLICY-SYNC"] ?? "").toLowerCase() === "true";
  if (policySyncEnabled) {
    const bundlePath = (env["INPUT_POLICY-BUNDLE"] ?? "").trim();
    if (!bundlePath) {
      throw new Error("`policy-bundle` is required when `policy-sync` is 'true'");
    }
    const dryRun = (env["INPUT_POLICY-DRY-RUN"] ?? "true").toLowerCase() !== "false";
    return {
      apiKey,
      apiUrl,
      failOnDeny,
      policySync: {
        bundlePath,
        source: (env["INPUT_POLICY-SOURCE"] ?? "").trim() || void 0,
        dryRun
      }
    };
  }
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
    const evaluations = parsed;
    for (const item of evaluations) {
      assertValidActionType(item.action);
      item.action = normalizeProtectedAction(item.action).canonical;
    }
    return {
      apiKey,
      apiUrl,
      failOnDeny,
      evaluations,
      waitForId: env["INPUT_WAIT-FOR-ID"] || void 0,
      waitTimeoutMs: parseInt(env["INPUT_WAIT-TIMEOUT-MS"] || "600000", 10)
    };
  }
  const rawAction = required(env, "INPUT_ACTION");
  assertValidActionType(rawAction);
  const action = normalizeProtectedAction(rawAction).canonical;
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
    throw new Error(
      key === "ATLASENT_API_KEY" ? "Missing required secret: ATLASENT_API_KEY" : `Missing required input: ${key.replace("INPUT_", "").toLowerCase()}`
    );
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
  const r = await fetch(`${opts.apiUrl}/v1-evaluate/stream`, {
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
    throw new Error(`atlasent /v1-evaluate/stream ${r.status}`);
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
        `${opts.apiUrl}/v1-evaluate/${encodeURIComponent(opts.evaluationId)}`,
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

// src/evidenceClient.ts
async function emitEvidenceEvent(cfg, event, log = console) {
  const url = `${cfg.apiUrl.replace(/\/$/, "")}${cfg.endpoint ?? "/v1-runtime-events"}`;
  const timeoutMs = cfg.timeoutMs ?? 5e3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(event),
      signal: controller.signal
    });
    if (res.status === 404) {
      log.info(
        `AtlaSent: runtime evidence endpoint not present at ${url} (skipping ${event.event_type})`
      );
      return;
    }
    if (!res.ok) {
      log.warning(
        `AtlaSent: evidence emit ${event.event_type} \u2192 HTTP ${res.status} (advisory; build not affected)`
      );
      return;
    }
    log.info(`AtlaSent: evidence event ${event.event_type} emitted`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warning(
      `AtlaSent: evidence emit failed (advisory; build not affected): ${msg}`
    );
  } finally {
    clearTimeout(timer);
  }
}

// src/v21.ts
async function emitBatchEvidence(decisions, items, cfg, log = console) {
  const tasks = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const item = items[i];
    if (!d || !item)
      continue;
    if (d.decision !== "allow")
      continue;
    if (d.verified !== true)
      continue;
    if (!d.permitToken || !d.id)
      continue;
    tasks.push(
      emitEvidenceEvent(
        cfg,
        {
          event_type: "execution_started",
          permit_token: d.permitToken,
          evaluation_id: d.id,
          environment: item.environment ?? "unknown",
          execution_started_at: (/* @__PURE__ */ new Date()).toISOString(),
          metadata: {
            ...item.context ?? {},
            source: "github-action-batch",
            action: item.action,
            actor: item.actor
          }
        },
        log
      ).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warning(`AtlaSent: batch emit threw (advisory): ${msg}`);
      })
    );
  }
  await Promise.allSettled(tasks);
}
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
  await emitBatchEvidence(decisions, items, {
    apiKey: inputs.apiKey,
    apiUrl: inputs.apiUrl
  });
  const failed = decisions.some(
    (d) => d.decision === "deny" || d.decision === "hold" || d.decision === "escalate"
  );
  return { decisions, failed, batchId: batch.batchId };
}

// src/policySync.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
async function runPolicySync(opts) {
  const { apiKey, apiUrl, bundlePath, source, commitSha, ref, dryRun } = opts;
  const workspace = process.env["GITHUB_WORKSPACE"] ?? ".";
  const absPath = path.isAbsolute(bundlePath) ? bundlePath : path.resolve(workspace, bundlePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(
      `Policy bundle not found: ${bundlePath} (resolved to ${absPath})`
    );
  }
  let policies;
  try {
    const raw = fs.readFileSync(absPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Policy bundle must be a JSON array of policy entries");
    }
    policies = parsed;
  } catch (err) {
    throw new Error(
      `Failed to parse policy bundle at ${bundlePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (policies.length === 0) {
    throw new Error("Policy bundle is empty \u2014 at least one entry is required");
  }
  const url = `${apiUrl.replace(/\/$/, "")}/v1/policy-sync`;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        policies,
        source: source ?? "github-action",
        commit_sha: commitSha,
        ref,
        dry_run: dryRun
      })
    });
  } catch (err) {
    throw new Error(
      `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = await resp.json();
      detail = errBody.error ?? errBody.message ?? "";
    } catch {
    }
    throw new Error(
      `v1-policy-sync responded ${resp.status}${detail ? `: ${detail}` : ""}`
    );
  }
  let run2;
  try {
    run2 = await resp.json();
  } catch {
    throw new Error("Could not parse JSON response from v1-policy-sync");
  }
  return {
    run: run2,
    diff: formatSyncDiff(run2),
    rejected: run2.status === "rejected" || run2.status === "failed"
  };
}
function formatSyncDiff(run2) {
  const parts = [];
  if (run2.policies_added > 0)
    parts.push(`+${run2.policies_added} added`);
  if (run2.policies_updated > 0)
    parts.push(`~${run2.policies_updated} updated`);
  if (run2.policies_removed > 0)
    parts.push(`-${run2.policies_removed} removed`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

// src/governanceAgents.ts
var import_node_crypto = require("node:crypto");
var fs2 = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));
var SEVERITY_RANK = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  blocker: 5
};
async function runGovernanceAgents(opts) {
  if (!opts.apiKey)
    throw new Error("apiKey is required");
  if (!opts.apiUrl)
    throw new Error("apiUrl is required");
  if (!opts.changeId) {
    throw new Error("changeId is required \u2014 set governance-change-id input");
  }
  if (opts.agentSlugs.length === 0) {
    throw new Error("agentSlugs must be non-empty");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fs_ = opts.fileSystem ?? defaultFs();
  const workspace = opts.workspace ?? process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const artifactMap = opts.artifactFile ? readArtifactFile(opts.artifactFile, workspace, fs_) : {};
  const evaluations = [];
  const findings = [];
  for (const slug of opts.agentSlugs) {
    const artifact = artifactMap[slug] ?? autoDiscoverArtifact(slug, workspace, fs_);
    if (!artifact) {
      throw new Error(
        `No artifact for agent "${slug}". Either supply one via governance-artifact-file (a JSON object keyed by agent slug) or use a slug that supports auto-discovery (migration_review, runtime_contract_drift).`
      );
    }
    const result = await invokeAgent(
      {
        apiKey: opts.apiKey,
        apiUrl: opts.apiUrl,
        changeId: opts.changeId,
        slug,
        artifact,
        invokedBy: opts.invokedBy ?? "github-action",
        fetchImpl
      }
    );
    evaluations.push(result.evaluation);
    findings.push(...result.findings);
  }
  const highest = highestSeverity(findings);
  const failed = !!opts.failOnSeverity && !!highest && SEVERITY_RANK[highest] >= SEVERITY_RANK[opts.failOnSeverity];
  return { evaluations, findings, highest_severity: highest, failed };
}
async function invokeAgent(args) {
  const url = `${args.apiUrl.replace(/\/$/, "")}/v1/governance/agents/${encodeURIComponent(args.slug)}/evaluate`;
  const body = JSON.stringify({
    change_id: args.changeId,
    input_hash: hashArtifact(args.artifact),
    artifact: args.artifact,
    invoked_by_kind: "service_account",
    invoked_by: args.invokedBy
  });
  let resp;
  try {
    resp = await args.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`
      },
      body
    });
  } catch (err) {
    throw new Error(
      `governance agent ${args.slug}: network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 501) {
      throw new Error(
        `governance agent ${args.slug}: registered in the DB but no in-process implementation is deployed (501). Skip this slug or upgrade the API.`
      );
    }
    throw new Error(
      `governance agent ${args.slug}: HTTP ${resp.status} ${resp.statusText} \u2014 ${text.slice(0, 500)}`
    );
  }
  const parsed = await resp.json();
  if (!parsed.evaluation || !Array.isArray(parsed.findings)) {
    throw new Error(`governance agent ${args.slug}: malformed response`);
  }
  return parsed;
}
var MIGRATION_DIRS = [
  "supabase/migrations",
  "supabase/migrations-runtime",
  "supabase/migrations-console",
  "supabase/migrations-shared"
];
function defaultFs() {
  return {
    readFileSync: (p, enc) => fs2.readFileSync(p, enc),
    existsSync: (p) => fs2.existsSync(p),
    readdirSync: (p) => fs2.readdirSync(p),
    statSync: (p) => fs2.statSync(p)
  };
}
function autoDiscoverArtifact(slug, workspace, fs_) {
  if (slug === "migration_review")
    return discoverMigrationArtifact(workspace, fs_);
  if (slug === "runtime_contract_drift")
    return discoverRuntimeContractArtifact(workspace, fs_);
  return null;
}
function discoverMigrationArtifact(workspace, fs_) {
  const files = [];
  for (const dir of MIGRATION_DIRS) {
    const abs = path2.resolve(workspace, dir);
    if (!fs_.existsSync(abs))
      continue;
    if (!fs_.statSync(abs).isDirectory())
      continue;
    for (const entry of fs_.readdirSync(abs)) {
      if (!entry.endsWith(".sql"))
        continue;
      const full = path2.join(abs, entry);
      if (!fs_.statSync(full).isFile())
        continue;
      files.push({
        path: path2.relative(workspace, full),
        content: fs_.readFileSync(full, "utf-8")
      });
    }
  }
  return { migrations: files };
}
function discoverRuntimeContractArtifact(workspace, fs_) {
  const openapiPath = ["openapi.yaml", "openapi-v1.yaml", "openapi.yml"].map((p) => path2.resolve(workspace, p)).find((p) => fs_.existsSync(p));
  if (!openapiPath)
    return null;
  const openapi = parseOpenApiPaths(fs_.readFileSync(openapiPath, "utf-8"));
  const routesDir = path2.resolve(workspace, "supabase/functions");
  const routes = fs_.existsSync(routesDir) ? discoverRuntimeRoutes(routesDir, fs_) : [];
  const typeNames = [];
  const typesIndex = path2.resolve(workspace, "packages/types/src/index.ts");
  if (fs_.existsSync(typesIndex)) {
    const content = fs_.readFileSync(typesIndex, "utf-8");
    for (const m of content.matchAll(/export\s+(?:type|interface)\s+([A-Z][A-Za-z0-9_]*)/g)) {
      typeNames.push(m[1]);
    }
  }
  return {
    openapi: { paths: openapi },
    runtime: { routes },
    sdk: { type_names: typeNames }
  };
}
function parseOpenApiPaths(yaml) {
  const out = [];
  const lines = yaml.split("\n");
  let inPaths = false;
  let currentPath = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!inPaths) {
      if (/^paths:\s*$/.test(line))
        inPaths = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) {
      inPaths = false;
      if (currentPath) {
        out.push(currentPath);
        currentPath = null;
      }
      continue;
    }
    const pathMatch = /^  (\/[\w/{}.-]+):/.exec(line);
    if (pathMatch) {
      if (currentPath)
        out.push(currentPath);
      currentPath = { path: pathMatch[1], methods: [] };
      continue;
    }
    const methodMatch = /^    (get|post|put|patch|delete):/i.exec(line);
    if (methodMatch && currentPath) {
      currentPath.methods.push(methodMatch[1].toLowerCase());
    }
  }
  if (currentPath)
    out.push(currentPath);
  return out;
}
function discoverRuntimeRoutes(routesDir, fs_) {
  const routes = [];
  for (const entry of fs_.readdirSync(routesDir)) {
    if (!entry.startsWith("v1-"))
      continue;
    const dir = path2.join(routesDir, entry);
    if (!fs_.statSync(dir).isDirectory())
      continue;
    const inferredPath = "/" + entry.replace(/-/g, "/").replace(/^\//, "");
    routes.push({
      path: inferredPath,
      // Methods unknown without parsing the handler; leave empty so the
      // drift agent treats per-method as "not asserted by runtime" and
      // only flags path-level drift.
      methods: [],
      function_name: entry
    });
  }
  return routes;
}
function readArtifactFile(artifactPath, workspace, fs_) {
  const abs = path2.isAbsolute(artifactPath) ? artifactPath : path2.resolve(workspace, artifactPath);
  if (!fs_.existsSync(abs)) {
    throw new Error(`governance-artifact-file not found: ${artifactPath}`);
  }
  const raw = fs_.readFileSync(abs, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `governance-artifact-file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "governance-artifact-file must be a JSON object keyed by agent slug"
    );
  }
  return parsed;
}
function hashArtifact(artifact) {
  const canonical = canonicalJson(artifact);
  return "sha256:" + (0, import_node_crypto.createHash)("sha256").update(canonical).digest("hex");
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}
function highestSeverity(findings) {
  let best = null;
  let rank = 0;
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > rank) {
      rank = SEVERITY_RANK[f.severity];
      best = f.severity;
    }
  }
  return best;
}
function renderStepSummary(result) {
  const lines = [];
  lines.push("## Constrained Governance Agents \u2014 findings");
  lines.push("");
  lines.push(
    "> Findings are advisory. They produce signal, not authorization. Required gates remain on the governance authority surface."
  );
  lines.push("");
  for (const e of result.evaluations) {
    lines.push(`### ${e.agent_slug} \`${e.agent_version}\``);
    lines.push("");
    lines.push(
      `Status: **${e.status}** \u2014 findings: **${e.findings_count}** \u2014 highest: **${e.highest_severity ?? "\u2014"}**`
    );
    if (e.summary)
      lines.push(`> ${e.summary}`);
    lines.push("");
    const own = result.findings.filter((f) => f.agent_slug === e.agent_slug);
    if (own.length === 0) {
      lines.push("_No findings._");
      lines.push("");
      continue;
    }
    lines.push("| Severity | Type | Authority | Summary |");
    lines.push("|---|---|---|---|");
    for (const f of own) {
      const auth = f.required_authority ?? "\u2014";
      const summary = f.summary.replace(/\|/g, "\\|").replace(/\n+/g, " ");
      lines.push(`| ${f.severity} | \`${f.finding_type}\` | ${auth} | ${summary} |`);
    }
    lines.push("");
  }
  if (result.highest_severity) {
    lines.push(`**Overall highest severity:** \`${result.highest_severity}\``);
  } else {
    lines.push("**No findings.**");
  }
  return lines.join("\n") + "\n";
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

// src/releaseCandidate.ts
async function postJson(url, token, body, fetchFn = globalThis.fetch) {
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "data" in parsed && parsed.success) {
      return parsed.data;
    }
    return parsed;
  } catch {
    throw new Error(`POST ${url} returned non-JSON body: ${text.slice(0, 200)}`);
  }
}
async function registerAndVerify(inputs, fetchFn = globalThis.fetch) {
  const base = inputs.controlPlaneUrl.replace(/\/$/, "");
  const registered = await postJson(
    `${base}/v1/release/candidates`,
    inputs.controlPlaneToken,
    {
      repo: inputs.repo,
      commitSha: inputs.commitSha,
      imageDigest: inputs.imageDigest,
      semver: inputs.semver,
      environment: inputs.environment,
      targetRuntimeUrl: inputs.targetRuntimeUrl
    },
    fetchFn
  );
  const runtime = await postJson(
    `${base}/v1/release/candidates/${registered.candidateId}/verify/runtime`,
    inputs.controlPlaneToken,
    {},
    fetchFn
  );
  const deploy = await postJson(
    `${base}/v1/release/candidates/${registered.candidateId}/verify/deploy`,
    inputs.controlPlaneToken,
    {},
    fetchFn
  );
  return { candidateId: registered.candidateId, runtime, deploy };
}
function summarizeOutcome(o) {
  if (o.status === "passed")
    return { ok: true, level: "passed" };
  if (o.status === "partial")
    return { ok: true, level: "warned" };
  return { ok: false, level: "failed" };
}

// src/evidenceBundle.ts
var import_node_crypto2 = require("node:crypto");
function genId() {
  return (0, import_node_crypto2.randomUUID)();
}
function hmacSha256(secret, input) {
  return (0, import_node_crypto2.createHmac)("sha256", secret).update(input, "utf8").digest("hex");
}
function sha256Hex(input) {
  return (0, import_node_crypto2.createHash)("sha256").update(input, "utf8").digest("hex");
}
function buildComplianceControls(hasAuditHash) {
  return [
    {
      control_id: "CC7.2",
      framework: "SOC2",
      satisfied: true,
      evidence_type: "audit_trail"
    },
    {
      control_id: "CC8.1",
      framework: "SOC2",
      satisfied: true,
      evidence_type: "change_management_gate"
    },
    {
      control_id: "CC6.1",
      framework: "SOC2",
      satisfied: true,
      evidence_type: "logical_access_control"
    },
    {
      control_id: "CC3.2",
      framework: "SOC2",
      // CC3.2 (policy violations) requires the audit hash to be present.
      satisfied: hasAuditHash,
      evidence_type: "policy_evaluation_evidence"
    }
  ];
}
function buildEvidenceBundle(args) {
  const receiptId = genId();
  const bundleId = genId();
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const receiptPayload = {
    receipt_id: receiptId,
    evaluation_id: args.evaluationId,
    permit_id: args.permitToken || null,
    audit_hash: args.auditHash ?? null,
    issued_at: generatedAt,
    action: args.action,
    actor: args.actor,
    environment: args.environment,
    repository: args.repository,
    sha: args.sha,
    run_id: args.runId,
    decision: "allow"
  };
  let signature = null;
  let algorithm = "none";
  if (args.signingSecret) {
    const sigInput = `${receiptId}
${generatedAt}
${JSON.stringify(receiptPayload)}`;
    signature = hmacSha256(args.signingSecret, sigInput);
    algorithm = "hmac-sha256";
  }
  const receipt = {
    ...receiptPayload,
    algorithm,
    signature,
    signing_key_id: args.signingKeyId ?? null
  };
  const hasAuditHash = Boolean(args.auditHash);
  const complianceControls = buildComplianceControls(hasAuditHash);
  const bundleBody = {
    v: 1,
    bundle_id: bundleId,
    action: args.action,
    actor: args.actor,
    decision: "allow",
    environment: args.environment,
    repository: args.repository,
    sha: args.sha,
    run_id: args.runId,
    run_url: args.runUrl,
    receipt,
    compliance_controls: complianceControls,
    generated_at: generatedAt
  };
  const bundleHash = sha256Hex(JSON.stringify(bundleBody));
  return { ...bundleBody, bundle_hash: bundleHash };
}

// src/postDeployEvidenceBundle.ts
var VALID_EVIDENCE_REGIMES = /* @__PURE__ */ new Set([
  "soc2_type_ii",
  "hipaa",
  "gdpr"
]);
function isoNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function isoOffsetDays(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1e3).toISOString();
}
async function callPostDeployEvidenceBundle(args, log, timeoutMs = 3e4) {
  const empty = { sha256: "", exportId: "" };
  const url = `${args.apiUrl.replace(/\/$/, "")}/v1/orgs/${encodeURIComponent(args.orgId)}/evidence-exports`;
  const windowTo = isoNow();
  const windowFrom = isoOffsetDays(args.days);
  const body = {
    regime: args.regime,
    window: { from: windowFrom, to: windowTo }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        ...args.actor ? { "X-AtlaSent-Actor": args.actor } : {}
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (res.status === 402) {
      log.warning(
        "AtlaSent evidence-bundle: organization is not on the enterprise plan (HTTP 402). Upgrade to generate compliance evidence bundles from CI."
      );
      return empty;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warning(
        `AtlaSent evidence-bundle: POST ${url} \u2192 HTTP ${res.status} (advisory; build not affected). ${text}`.trim()
      );
      return empty;
    }
    const data = await res.json();
    const exportId = data.export?.id ?? "";
    const sha256 = data.sha256 ?? data.export?.bundle_sha256 ?? "";
    log.info(`AtlaSent evidence-bundle: export ${exportId} sha256=${sha256}`);
    return { sha256, exportId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warning(
      `AtlaSent evidence-bundle: request failed (advisory; build not affected): ${msg}`
    );
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

// src/vqpVerify.ts
async function runVqpVerify(inputs, fetchFn = globalThis.fetch) {
  const base = inputs.supabaseUrl.replace(/\/$/, "");
  const url = `${base}/functions/v1/v1-verify-vqp`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${inputs.serviceRoleKey}`
    },
    body: JSON.stringify({
      snapshot_id: inputs.snapshotId,
      rerun: inputs.rerun
    })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`v1-verify-vqp failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`v1-verify-vqp returned non-JSON: ${text.slice(0, 200)}`);
  }
  const body = parsed.success && parsed.data ? parsed.data : parsed;
  return {
    hashMatch: body.hash_match === true,
    scoreDelta: body.score_delta !== void 0 ? body.score_delta : null,
    verdictChanged: body.verdict_changed === true,
    auditId: body.audit_id ?? ""
  };
}

// src/index.ts
function getApiKey() {
  const apiKey = (process.env["ATLASENT_API_KEY"] ?? "").trim();
  if (!apiKey) {
    setFailed("ATLASENT_API_KEY is required");
  }
  return apiKey;
}
function normalizeAndValidateProtectedAction(actionType) {
  const { canonical } = normalizeProtectedAction(actionType);
  if (canonical !== PRODUCTION_DEPLOY_ACTION) {
    setOutput("decision", "error");
    setOutput("verified", "false");
    setFailed(
      `AtlaSent Gate: unsupported protected action "${actionType}". Deploy Gate V1 only permits "${PRODUCTION_DEPLOY_ACTION}" (legacy alias "${LEGACY_PRODUCTION_DEPLOY_ALIAS}" is accepted during the V1 alias window).`
    );
  }
  return canonical;
}
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
    const fs3 = require("node:fs");
    fs3.appendFileSync(outputFile, `${name}=${value}
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
async function postCommitStatus(args) {
  const token = process.env["GITHUB_TOKEN"];
  if (!token || !args.sha || !args.repository)
    return;
  const apiBase = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
  const url = `${apiBase}/repos/${args.repository}/statuses/${args.sha}`;
  const body = {
    state: args.state,
    description: args.description.slice(0, 140),
    // GitHub caps at 140 chars
    context: args.context ?? "AtlaSent Policy Gate"
  };
  if (args.targetUrl)
    body.target_url = args.targetUrl;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable>");
      warning(`AtlaSent: commit status post failed (${res.status}): ${text}`);
    }
  } catch (err) {
    warning(
      `AtlaSent: commit status post error (advisory, non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
async function notifySlack(webhookUrl, opts) {
  const emoji = opts.decision === "deny" ? ":no_entry:" : opts.decision === "hold" ? ":hourglass_flowing_sand:" : opts.decision === "escalate" ? ":rotating_light:" : ":warning:";
  const label = opts.decision === "deny" ? "DENIED" : opts.decision === "hold" ? "ON HOLD" : opts.decision === "escalate" ? "ESCALATED" : "BLOCKED";
  const fields = [
    { type: "mrkdwn", text: `*Actor:*
${opts.actor}` },
    { type: "mrkdwn", text: `*Environment:*
${opts.environment}` }
  ];
  if (opts.evaluationId) {
    fields.push({ type: "mrkdwn", text: `*Evaluation ID:*
${opts.evaluationId}` });
  }
  if (opts.auditHash) {
    fields.push({
      type: "mrkdwn",
      text: `*Audit hash:*
\`${opts.auditHash.slice(0, 16)}\u2026\``
    });
  }
  const payload = {
    text: `${emoji} AtlaSent Deploy Gate ${label}: ${opts.action} (${opts.environment})`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} AtlaSent: Deploy ${label}`, emoji: true }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Action:* \`${opts.action}\`
*Reason:* ${opts.reason}`
        }
      },
      { type: "section", fields },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Run", emoji: false },
            url: opts.runUrl
          }
        ]
      }
    ]
  };
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      warning(`AtlaSent: Slack notification failed (${res.status}) \u2014 advisory, non-blocking`);
    }
  } catch (err) {
    warning(
      `AtlaSent: Slack notification error (advisory, non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function buildGateDenyComment(opts) {
  const icon = opts.decision === "deny" ? "\u{1F534}" : opts.decision === "hold" ? "\u{1F7E1}" : opts.decision === "escalate" ? "\u{1F6A8}" : "\u274C";
  const label = opts.decision === "deny" ? "DENIED" : opts.decision === "hold" ? "ON HOLD" : opts.decision === "escalate" ? "ESCALATED" : "BLOCKED";
  const lines = [
    `## ${icon} AtlaSent Deploy Gate \u2014 ${label}`,
    "",
    `The AtlaSent gate blocked \`${opts.action}\` for actor **${opts.actor}** in **${opts.environment}**.`,
    "",
    `**Decision:** \`${opts.decision}\``,
    `**Reason:** ${opts.reason}`
  ];
  if (opts.evaluationId) {
    lines.push(`**Evaluation ID:** \`${opts.evaluationId}\``);
  }
  if (opts.auditHash) {
    lines.push(`**Audit hash:** \`${opts.auditHash.slice(0, 24)}\u2026\``);
  }
  lines.push("", `[View workflow run](${opts.runUrl})`);
  if (opts.decision === "hold" || opts.decision === "escalate") {
    lines.push(
      "",
      "> **Next step:** An authorized reviewer must approve this deployment in the [AtlaSent console](https://console.atlasent.io/approvals) or via the Slack Approval Bot."
    );
  }
  return lines.join("\n");
}
async function postPRComment(args) {
  const token = process.env["GITHUB_TOKEN"];
  if (!token || !args.repository || !args.prNumber)
    return;
  const apiBase = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
  const url = `${apiBase}/repos/${args.repository}/issues/${args.prNumber}/comments`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ body: args.body })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable>");
      warning(
        `AtlaSent: PR comment post failed (${res.status}): ${text.slice(0, 200)} \u2014 advisory, non-blocking`
      );
    }
  } catch (err) {
    warning(
      `AtlaSent: PR comment post error (advisory, non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
      const fs3 = require("node:fs");
      fs3.appendFileSync(summaryFile, content);
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
var VALID_SEVERITIES = [
  "info",
  "low",
  "medium",
  "high",
  "blocker"
];
async function runGovernanceAgentsStep(apiKey, apiUrl) {
  const slugsRaw = getInput("governance-agents", true);
  const agentSlugs = slugsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (agentSlugs.length === 0) {
    setFailed("governance-agents input is empty after trimming");
    return;
  }
  const changeId = getInput("governance-change-id", true);
  const artifactFile = getInput("governance-artifact-file") || void 0;
  const failOnBlocker = getInput("governance-fail-on-blocker").toLowerCase() === "true";
  const failOnSeverityRaw = getInput("governance-fail-on-severity");
  let failOnSeverity;
  if (failOnSeverityRaw) {
    if (!VALID_SEVERITIES.includes(failOnSeverityRaw)) {
      setFailed(
        `governance-fail-on-severity must be one of ${VALID_SEVERITIES.join("|")} (got "${failOnSeverityRaw}")`
      );
      return;
    }
    failOnSeverity = failOnSeverityRaw;
  } else if (failOnBlocker) {
    failOnSeverity = "blocker";
  }
  const gh = getGitHubContext();
  info(
    `AtlaSent Governance Agents: running [${agentSlugs.join(", ")}] against change ${changeId} (commit ${gh.sha.slice(0, 8)})`
  );
  let result;
  try {
    result = await runGovernanceAgents({
      apiKey,
      apiUrl,
      changeId,
      agentSlugs,
      artifactFile,
      failOnSeverity,
      invokedBy: `github-action:${gh.repository}@${gh.sha.slice(0, 8)}`
    });
  } catch (err) {
    setOutput("governance-findings-count", "0");
    setOutput("governance-highest-severity", "");
    setOutput("governance-evaluations", "[]");
    setOutput("governance-findings", "[]");
    setFailed(
      `AtlaSent Governance Agents: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  setOutput("governance-findings-count", String(result.findings.length));
  setOutput("governance-highest-severity", result.highest_severity ?? "");
  setOutput("governance-evaluations", JSON.stringify(result.evaluations));
  setOutput("governance-findings", JSON.stringify(result.findings));
  appendToStepSummary(renderStepSummary(result));
  if (result.failed) {
    setFailed(
      `Governance findings at or above severity "${failOnSeverity}" \u2014 highest emitted: ${result.highest_severity}`
    );
    return;
  }
  if (result.highest_severity) {
    warning(
      `Governance Agents: highest severity ${result.highest_severity} (advisory; not gating)`
    );
  } else {
    info("Governance Agents: no findings.");
  }
}
async function runPolicySyncStep(apiKey, apiUrl) {
  const bundlePath = getInput("policy-bundle", true);
  const source = getInput("policy-source") || "github-action";
  const dryRun = getInput("policy-dry-run").toLowerCase() !== "false";
  const gh = getGitHubContext();
  info(
    `AtlaSent Policy Sync: submitting "${bundlePath}" (source=${source}, dry_run=${dryRun}, sha=${gh.sha.slice(0, 8)})`
  );
  let result;
  try {
    result = await runPolicySync({
      apiKey,
      apiUrl,
      bundlePath,
      source,
      commitSha: gh.sha,
      ref: gh.ref,
      dryRun
    });
  } catch (err) {
    setOutput("sync-run-id", "");
    setOutput("sync-status", "error");
    setOutput("sync-diff", "");
    setOutput("sync-summary", "");
    setFailed(
      `AtlaSent Policy Sync: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  const { run: run2, diff, rejected } = result;
  setOutput("sync-run-id", run2.id ?? "");
  setOutput("sync-status", run2.status);
  setOutput("sync-diff", diff);
  setOutput(
    "sync-summary",
    JSON.stringify({
      added: run2.policies_added,
      updated: run2.policies_updated,
      removed: run2.policies_removed,
      status: run2.status
    })
  );
  appendToStepSummary(
    [
      "",
      "## \u{1F4CB} AtlaSent Policy Sync",
      "",
      `| Field | Value |`,
      `|---|---|`,
      `| Run ID | \`${run2.id ?? "n/a"}\` |`,
      `| Status | \`${run2.status}\` |`,
      `| Mode | ${dryRun ? "Dry run (preview only)" : "Applied"} |`,
      `| Changes | ${diff} |`,
      `| Source | \`${source}\` |`,
      `| Ref | \`${gh.ref}\` |`,
      `| Commit | \`${gh.sha.slice(0, 8)}\` |`,
      ""
    ].join("\n")
  );
  if (rejected) {
    setFailed(
      `AtlaSent Policy Sync: bundle ${run2.status} \u2014 ${diff}. Fix policy errors and push again.`
    );
    return;
  }
  if (dryRun) {
    info(`Policy sync dry run: ${diff}`);
    info(`  Run ID: ${run2.id}`);
    info(`  Set policy-dry-run: 'false' on the default branch to apply.`);
  } else {
    info(`Policy sync applied: ${diff}`);
    info(`  Run ID: ${run2.id}`);
  }
}
async function runReleaseModeStep() {
  const cpUrl = getInput("control-plane-url", true);
  const cpToken = getInput("control-plane-token") || (process.env["ATLASENT_CP_TOKEN"] ?? "").trim();
  if (!cpToken) {
    setFailed(
      "release-mode: control-plane-token input or ATLASENT_CP_TOKEN env var is required"
    );
    return;
  }
  maskValue(cpToken);
  const targetUrl = getInput("release-target-runtime-url", true);
  const gh = getGitHubContext();
  const repo = getInput("release-repo") || gh.repository;
  const commitSha = getInput("release-commit-sha") || gh.sha;
  if (!commitSha) {
    setFailed("release-mode: commit SHA is required (set release-commit-sha or GITHUB_SHA)");
    return;
  }
  const imageDigest = getInput("release-image-digest") || void 0;
  const semver = getInput("release-semver") || void 0;
  const environment = getInput("release-environment", true);
  if (!["preview", "staging", "production"].includes(environment)) {
    setFailed(
      `release-mode: release-environment must be preview | staging | production (got "${environment}")`
    );
    return;
  }
  const failOnVerify = getInput("release-fail-on-verify").toLowerCase() !== "false";
  info(
    `AtlaSent release: registering candidate for ${repo}@${commitSha.slice(0, 8)} in ${environment} against ${targetUrl}`
  );
  let result;
  try {
    result = await registerAndVerify({
      controlPlaneUrl: cpUrl,
      controlPlaneToken: cpToken,
      targetRuntimeUrl: targetUrl,
      repo,
      commitSha,
      imageDigest,
      semver,
      environment
    });
  } catch (err) {
    setOutput("release-candidate-id", "");
    setOutput("release-runtime-status", "error");
    setOutput("release-deploy-status", "error");
    setOutput("release-runtime-result", "{}");
    setOutput("release-deploy-result", "{}");
    setFailed(
      `AtlaSent release: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  setOutput("release-candidate-id", result.candidateId);
  setOutput("release-runtime-status", result.runtime.status);
  setOutput("release-deploy-status", result.deploy.status);
  setOutput("release-runtime-result", JSON.stringify(result.runtime));
  setOutput("release-deploy-result", JSON.stringify(result.deploy));
  const runtimeSummary = summarizeOutcome(result.runtime);
  const deploySummary = summarizeOutcome(result.deploy);
  info(`  Candidate: ${result.candidateId}`);
  info(`  Runtime verify: ${result.runtime.status}`);
  for (const c of result.runtime.checks) {
    info(`    \u2022 ${c.name}: ${c.status}${c.detail ? ` \u2014 ${c.detail}` : ""}`);
  }
  info(`  Deploy verify: ${result.deploy.status}`);
  for (const c of result.deploy.checks) {
    info(`    \u2022 ${c.name}: ${c.status}${c.detail ? ` \u2014 ${c.detail}` : ""}`);
  }
  appendToStepSummary(
    [
      "",
      "## \u{1F680} AtlaSent Release Candidate",
      "",
      `| Field | Value |`,
      `|---|---|`,
      `| Candidate ID | \`${result.candidateId}\` |`,
      `| Repo | \`${repo}\` |`,
      `| Commit | \`${commitSha.slice(0, 8)}\` |`,
      `| Environment | \`${environment}\` |`,
      `| Runtime verify | ${runtimeSummary.level === "passed" ? "\u2705" : runtimeSummary.level === "warned" ? "\u26A0\uFE0F" : "\u274C"} \`${result.runtime.status}\` |`,
      `| Deploy verify | ${deploySummary.level === "passed" ? "\u2705" : deploySummary.level === "warned" ? "\u26A0\uFE0F" : "\u274C"} \`${result.deploy.status}\` |`,
      ""
    ].join("\n")
  );
  if (failOnVerify && (!runtimeSummary.ok || !deploySummary.ok)) {
    const failed = [];
    if (!runtimeSummary.ok)
      failed.push(`runtime=${result.runtime.status}`);
    if (!deploySummary.ok)
      failed.push(`deploy=${result.deploy.status}`);
    setFailed(
      `AtlaSent release: verification failed (${failed.join(", ")}). Promotion should not proceed.`
    );
    return;
  }
}
async function runVqpVerifyStep() {
  const snapshotId = getInput("vqp-snapshot-id", true);
  const supabaseUrl = getInput("vqp-supabase-url") || (process.env["ATLASENT_SUPABASE_URL"] ?? "").trim();
  if (!supabaseUrl) {
    setFailed(
      "vqp-verify: vqp-supabase-url input or ATLASENT_SUPABASE_URL env var is required"
    );
    return;
  }
  const serviceRoleKey = getInput("vqp-service-role-key") || (process.env["ATLASENT_SUPABASE_SERVICE_ROLE_KEY"] ?? "").trim();
  if (!serviceRoleKey) {
    setFailed(
      "vqp-verify: vqp-service-role-key input or ATLASENT_SUPABASE_SERVICE_ROLE_KEY env var is required"
    );
    return;
  }
  maskValue(serviceRoleKey);
  const rerun = getInput("vqp-rerun").toLowerCase() === "true";
  const failOnDrift = getInput("vqp-fail-on-drift").toLowerCase() !== "false";
  info(
    `AtlaSent VQP verify: re-deriving snapshot ${snapshotId}` + (rerun ? " (with AI rerun)" : " (hash check only)")
  );
  const setEmptyVqpOutputs = () => {
    setOutput("vqp-hash-match", "false");
    setOutput("vqp-score-delta", "");
    setOutput("vqp-verdict-changed", "false");
    setOutput("vqp-audit-id", "");
  };
  let result;
  try {
    result = await runVqpVerify({ supabaseUrl, serviceRoleKey, snapshotId, rerun });
  } catch (err) {
    setEmptyVqpOutputs();
    setFailed(
      `AtlaSent VQP verify: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  setOutput("vqp-hash-match", result.hashMatch ? "true" : "false");
  setOutput(
    "vqp-score-delta",
    result.scoreDelta !== null ? String(result.scoreDelta) : ""
  );
  setOutput("vqp-verdict-changed", result.verdictChanged ? "true" : "false");
  setOutput("vqp-audit-id", result.auditId);
  info(`  Hash match:      ${result.hashMatch}`);
  if (result.scoreDelta !== null) {
    info(`  Score delta:     ${result.scoreDelta}`);
    info(`  Verdict changed: ${result.verdictChanged}`);
  }
  info(`  Audit ID:        ${result.auditId}`);
  appendToStepSummary(
    [
      "",
      "## \u{1F9EC} AtlaSent VQP Re-Derivation Audit",
      "",
      `| Field | Value |`,
      `|---|---|`,
      `| Snapshot ID | \`${snapshotId}\` |`,
      `| Hash Match | ${result.hashMatch ? "\u2705 `true`" : "\u274C `false`"} |`,
      result.scoreDelta !== null ? `| Score Delta | \`${result.scoreDelta}\` |` : "| Score Delta | N/A (rerun not requested) |",
      result.scoreDelta !== null ? `| Verdict Changed | ${result.verdictChanged ? "\u26A0\uFE0F `true`" : "\u2705 `false`"} |` : "| Verdict Changed | N/A |",
      `| Audit ID | \`${result.auditId || "\u2014"}\` |`,
      ""
    ].join("\n")
  );
  if (!failOnDrift) {
    if (!result.hashMatch) {
      warning(
        `VQP hash mismatch for snapshot ${snapshotId} (advisory; vqp-fail-on-drift=false)`
      );
    }
    return;
  }
  if (!result.hashMatch) {
    setFailed(
      `AtlaSent VQP verify: hash mismatch for snapshot ${snapshotId} \u2014 prompt was mutated after snapshot creation (integrity violation). Investigate vqp_snapshots and vqp_audit_log for root cause.`
    );
    return;
  }
  if (result.verdictChanged) {
    setFailed(
      `AtlaSent VQP verify: verdict changed for snapshot ${snapshotId} \u2014 score drift detected (rerun verdict differs from original). Review score_delta in vqp_audit_log.`
    );
    return;
  }
  info(
    `AtlaSent VQP verify: integrity confirmed for snapshot ${snapshotId}` + (rerun ? " \u2014 no score drift" : "")
  );
}
async function run() {
  if (getInput("release-mode") === "register-and-verify") {
    await runReleaseModeStep();
    return;
  }
  if (getInput("vqp-snapshot-id")) {
    await runVqpVerifyStep();
    return;
  }
  const apiKey = getApiKey();
  maskValue(apiKey);
  const apiUrl = getInput("api-url") || (process.env["ATLASENT_BASE_URL"] ?? "").trim() || "https://api.atlasent.io";
  const failOnDeny = getInput("fail-on-deny") !== "false";
  if (!failOnDeny) {
    warning(
      "Input fail-on-deny=false is deprecated for Deploy Gate V1 pilot readiness; deny/hold/escalate now fail closed."
    );
  }
  maskValue(apiKey);
  if (getInput("policy-sync").toLowerCase() === "true") {
    await runPolicySyncStep(apiKey, apiUrl);
    return;
  }
  if (getInput("governance-agents")) {
    await runGovernanceAgentsStep(apiKey, apiUrl);
    return;
  }
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
          ATLASENT_API_KEY: apiKey,
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
      {
        const gh2 = getGitHubContext();
        const runUrl = `${gh2.server_url}/${gh2.repository}/actions/runs/${gh2.run_id}`;
        const slackWebhook = getInput("slack-webhook");
        const prCommentEnabled = getInput("pr-comment-on-deny").toLowerCase() !== "false";
        const blockedDecisions = result.decisions.filter(
          (d2) => d2.decision === "deny" || d2.decision === "hold" || d2.decision === "escalate"
        );
        const worstDecision = blockedDecisions.some((d2) => d2.decision === "deny") ? "deny" : blockedDecisions.some((d2) => d2.decision === "escalate") ? "escalate" : "hold";
        const batchActor = getInput("actor") || "unknown";
        const batchEnv = resolveEnvironment(getInput("environment"), gh2.ref, apiKey);
        const reasonSummary = `${blockedDecisions.length} of ${result.decisions.length} evaluation(s) blocked (${worstDecision})`;
        if (slackWebhook) {
          await notifySlack(slackWebhook, {
            decision: worstDecision,
            action: "batch evaluation",
            actor: batchActor,
            environment: batchEnv,
            reason: reasonSummary,
            runUrl
          });
        }
        if (prCommentEnabled && gh2.pr_number) {
          await postPRComment({
            repository: gh2.repository,
            prNumber: gh2.pr_number,
            body: buildGateDenyComment({
              decision: worstDecision,
              reason: reasonSummary,
              action: "batch evaluation",
              actor: batchActor,
              environment: batchEnv,
              runUrl
            })
          });
        }
      }
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
  const rawActionType = getInput("action", true);
  const actionType = normalizeAndValidateProtectedAction(rawActionType);
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
      setOutput("evidence-receipt", JSON.stringify(null));
      setOutput("evidence-bundle", JSON.stringify(null));
      {
        const decision = err.decision?.decision;
        let statusState = "error";
        let statusDesc = `AtlaSent: gate error \u2014 ${err.message.slice(0, 100)}`;
        if (decision === "deny") {
          statusState = "failure";
          statusDesc = `AtlaSent: denied \u2014 ${err.decision?.denyReason ?? actionType}`.slice(0, 140);
        } else if (decision === "hold") {
          statusState = "pending";
          statusDesc = `AtlaSent: on hold \u2014 awaiting approval (${actionType})`;
        } else if (decision === "escalate") {
          statusState = "pending";
          statusDesc = `AtlaSent: escalated \u2014 manual review required (${actionType})`;
        }
        await postCommitStatus({
          repository: gh.repository,
          sha: gh.sha,
          state: statusState,
          description: statusDesc,
          targetUrl: `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`
        });
      }
      emitFinancialGovernanceAdvisory(actionType, actor, orgId);
      {
        const slackWebhook = getInput("slack-webhook");
        const runUrl = `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`;
        const decisionStr = err.decision?.decision ?? "error";
        const isActionable = decisionStr === "deny" || decisionStr === "hold" || decisionStr === "escalate";
        const reason = decisionStr === "deny" ? err.decision?.denyReason ?? "no reason provided" : decisionStr === "hold" ? err.decision?.holdReason ?? "awaiting approval" : decisionStr === "escalate" ? "escalated \u2014 manual review required" : err.message.slice(0, 200);
        if (slackWebhook && isActionable) {
          await notifySlack(slackWebhook, {
            decision: decisionStr,
            action: actionType,
            actor,
            environment,
            reason,
            runUrl,
            evaluationId: err.decision?.evaluationId,
            auditHash: err.decision?.auditHash
          });
        }
        const prCommentEnabled = getInput("pr-comment-on-deny").toLowerCase() !== "false";
        if (prCommentEnabled && gh.pr_number && isActionable) {
          await postPRComment({
            repository: gh.repository,
            prNumber: gh.pr_number,
            body: buildGateDenyComment({
              decision: decisionStr,
              reason,
              action: actionType,
              actor,
              environment,
              runUrl,
              evaluationId: err.decision?.evaluationId,
              auditHash: err.decision?.auditHash
            })
          });
        }
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
    setOutput("evidence-receipt", JSON.stringify(null));
    setOutput("evidence-bundle", JSON.stringify(null));
    await postCommitStatus({
      repository: gh.repository,
      sha: gh.sha,
      state: "error",
      description: `AtlaSent: unexpected error \u2014 ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`,
      targetUrl: `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`
    });
    emitFinancialGovernanceAdvisory(actionType, actor, orgId);
    setFailed(
      `AtlaSent Gate: Unexpected error: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  const { decision: d, verifyOutcome } = enforceResult;
  setDecisionOutputs(d);
  setOutput("verified", "true");
  await postCommitStatus({
    repository: gh.repository,
    sha: gh.sha,
    state: "success",
    description: `AtlaSent: authorized \u2014 ${actionType}`,
    targetUrl: `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`
  });
  info(`Authorization GRANTED (evaluate + verify)`);
  info(`  Permit token: (set as 'permit-token' output, masked in logs)`);
  info(`  Proof hash:   (set as 'proof-hash' output, masked in logs)`);
  info(`  Evaluation:   ${d.evaluationId ?? ""}`);
  if (d.riskScore !== void 0)
    info(`  Risk score:   ${d.riskScore}`);
  info(`  Verify:       ${verifyOutcome ?? "verified"}`);
  try {
    const receiptSigningSecret = process.env["ATLASENT_RECEIPT_SIGNING_SECRET"];
    const receiptSigningKeyId = getInput("receipt-signing-key-id");
    const runUrl = `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`;
    const bundle = buildEvidenceBundle({
      evaluationId: d.evaluationId ?? "",
      permitToken: d.permitToken ?? "",
      auditHash: d.auditHash,
      action: actionType,
      actor: `github:${actor}`,
      environment,
      repository: gh.repository,
      sha: gh.sha,
      runId: gh.run_id,
      runUrl,
      signingSecret: receiptSigningSecret || void 0,
      signingKeyId: receiptSigningKeyId || void 0
    });
    setOutput("evidence-receipt", JSON.stringify(bundle.receipt));
    setOutput("evidence-bundle", JSON.stringify(bundle));
    info(
      `  Evidence:     receipt=${bundle.receipt.receipt_id} algorithm=${bundle.receipt.algorithm}`
    );
  } catch (bundleErr) {
    warning(
      `AtlaSent: evidence bundle build failed (advisory; gate decision unaffected): ${bundleErr instanceof Error ? bundleErr.message : String(bundleErr)}`
    );
    setOutput("evidence-receipt", JSON.stringify(null));
    setOutput("evidence-bundle", JSON.stringify(null));
  }
  if (d.permitToken && d.evaluationId) {
    await emitEvidenceEvent(
      { apiKey, apiUrl },
      {
        event_type: "execution_started",
        permit_token: d.permitToken,
        evaluation_id: d.evaluationId,
        environment,
        execution_started_at: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          source: "github-action",
          repository: gh.repository,
          ref: gh.ref,
          sha: gh.sha,
          workflow: gh.workflow,
          run_id: gh.run_id,
          run_url: `${gh.server_url}/${gh.repository}/actions/runs/${gh.run_id}`,
          action: actionType,
          actor: `github:${actor}`
        }
      },
      { info, warning }
    );
  }
  emitFinancialGovernanceAdvisory(actionType, actor, orgId);
  await runPostDeployEvidenceBundleStep(apiKey, apiUrl, orgId, actor);
}
async function runPostDeployEvidenceBundleStep(apiKey, apiUrl, orgId, actor) {
  const bundleInput = getInput("evidence-bundle").toLowerCase();
  const setEmptyBundleOutputs = () => {
    setOutput("evidence-bundle-sha256", "");
    setOutput("evidence-bundle-id", "");
  };
  if (!bundleInput || bundleInput === "false") {
    setEmptyBundleOutputs();
    return;
  }
  const regime = bundleInput === "true" ? "soc2_type_ii" : bundleInput;
  if (!VALID_EVIDENCE_REGIMES.has(regime)) {
    warning(
      `AtlaSent evidence-bundle: unrecognized regime "${regime}". Expected one of: ${Array.from(VALID_EVIDENCE_REGIMES).join(", ")}. Skipping.`
    );
    setEmptyBundleOutputs();
    return;
  }
  const rawDays = getInput("evidence-bundle-days") || "90";
  const days = parseInt(rawDays, 10);
  if (Number.isNaN(days) || days < 1) {
    warning(
      `AtlaSent evidence-bundle: evidence-bundle-days must be a positive integer (got "${rawDays}"). Skipping.`
    );
    setEmptyBundleOutputs();
    return;
  }
  info(
    `AtlaSent evidence-bundle: generating ${regime} bundle (${days}-day window) for org ${orgId}`
  );
  const result = await callPostDeployEvidenceBundle(
    { apiUrl, apiKey, orgId, regime, days, actor: `github:${actor}` },
    { info, warning }
  );
  setOutput("evidence-bundle-sha256", result.sha256);
  setOutput("evidence-bundle-id", result.exportId);
  if (result.sha256) {
    info(`AtlaSent evidence-bundle: bundle_sha256=${result.sha256}`);
  }
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
