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
async function run() {
  const apiKey = getInput("api-key", true);
  const actionType = getInput("action", true);
  const actor = getInput("actor") || "unknown";
  const targetId = getInput("target-id") || void 0;
  const explicitEnv = getInput("environment");
  const apiUrl = getInput("api-url") || "https://api.atlasent.io";
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
  info(
    `AtlaSent Gate: evaluating "${actionType}" for actor "${actor}" in ${environment} environment` + (targetId ? ` (target=${targetId})` : "")
  );
  let decision;
  try {
    decision = await (0, import_enforce.evaluate)({
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
        ...extraContext
      }
    });
  } catch (err) {
    setOutput("decision", "error");
    setFailed(err instanceof import_enforce.EnforceError ? err.message : String(err));
  }
  const permitToken = decision.permitToken ?? "";
  const evaluationId = decision.evaluationId ?? "";
  const proofHash = decision.proofHash ?? "";
  const riskScore = decision.riskScore !== void 0 ? String(decision.riskScore) : "";
  if (permitToken)
    maskValue(permitToken);
  if (proofHash)
    maskValue(proofHash);
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
      if (riskScore)
        info(`  Risk score:   ${riskScore}`);
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
        setFailed("Authorization ESCALATED \u2014 manual review required");
      } else {
        warning("Authorization ESCALATED \u2014 manual review required");
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
