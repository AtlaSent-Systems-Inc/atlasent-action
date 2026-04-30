"use strict";
// @atlasent/enforce — fail-closed execution wrapper.
//
// Enforces the evaluate → verify → verifyPermit → execute contract:
//   1. evaluate()     — calls POST /v1/evaluate; any infra error blocks execution
//   2. verify()       — rejects non-allow decisions (deny / hold / escalate)
//   3. verifyPermit() — calls POST /v1/verify-permit; replay/expired tokens block
//   4. enforce()      — composes all three; fn never runs unless all steps pass
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnforceError = void 0;
exports.evaluate = evaluate;
exports.verify = verify;
exports.verifyPermit = verifyPermit;
exports.enforce = enforce;
const transport_1 = require("./transport");
const DEFAULT_API_URL = "https://api.atlasent.io";
class EnforceError extends Error {
    phase;
    decision;
    constructor(message, phase, decision = null) {
        super(message);
        this.name = "EnforceError";
        this.phase = phase;
        this.decision = decision;
    }
}
exports.EnforceError = EnforceError;
// ---------------------------------------------------------------------------
// Step 1 — evaluate
// ---------------------------------------------------------------------------
async function evaluate(config) {
    const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    const payload = {
        action_type: config.action,
        actor_id: config.actor,
        context: {
            ...(config.environment ? { environment: config.environment } : {}),
            ...(config.targetId ? { target_id: config.targetId } : {}),
            ...config.context,
        },
    };
    if (config.targetId)
        payload["target_id"] = config.targetId;
    let status;
    let body;
    try {
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1/evaluate`, JSON.stringify(payload), {
            Authorization: `Bearer ${config.apiKey}`,
        }));
    }
    catch (err) {
        throw new EnforceError(`AtlaSent API unreachable: ${err instanceof Error ? err.message : String(err)}`, "evaluate");
    }
    if (status >= 500) {
        throw new EnforceError(`Infrastructure failure (HTTP ${status})`, "evaluate");
    }
    if (status === 401 || status === 403) {
        throw new EnforceError(`Authentication failed (HTTP ${status})`, "evaluate");
    }
    if (status === 429) {
        throw new EnforceError("Rate limited (HTTP 429)", "evaluate");
    }
    if (status < 200 || status >= 300) {
        throw new EnforceError(`Unexpected response (HTTP ${status})`, "evaluate");
    }
    let raw;
    try {
        raw = JSON.parse(body);
    }
    catch {
        throw new EnforceError("Non-JSON response from AtlaSent API", "evaluate");
    }
    return mapDecision(raw);
}
// ---------------------------------------------------------------------------
// Step 2 — verify (decision check — no HTTP call)
// ---------------------------------------------------------------------------
function verify(decision) {
    switch (decision.decision) {
        case "allow":
            return;
        case "deny":
            throw new EnforceError(`Denied: ${decision.denyReason ?? "no reason provided"}`, "verify", decision);
        case "hold":
            throw new EnforceError(`On hold: ${decision.holdReason ?? "awaiting approval"}`, "verify", decision);
        case "escalate":
            throw new EnforceError("Escalated — manual review required", "verify", decision);
        default:
            throw new EnforceError(`Unknown decision: ${String(decision.decision)}`, "verify", decision);
    }
}
// ---------------------------------------------------------------------------
// Step 3 — verifyPermit (calls /v1/verify-permit, fail-closed)
//
// Without this round-trip the enforce wrapper is evaluate-only: a tampered or
// replayed permit_token would still surface decision=allow. This step consumes
// the token — downstream re-verify returns outcome=permit_consumed.
// ---------------------------------------------------------------------------
async function verifyPermit(config, decision) {
    if (!decision.permitToken) {
        throw new EnforceError("evaluate returned allow but no permit_token — refusing to execute without verifiable permit", "verify-permit", decision);
    }
    const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    let status;
    let body;
    try {
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1/verify-permit`, JSON.stringify({
            permit_token: decision.permitToken,
            action_type: config.action,
            actor_id: config.actor,
        }), { Authorization: `Bearer ${config.apiKey}` }));
    }
    catch (err) {
        throw new EnforceError(`verify-permit unreachable: ${err instanceof Error ? err.message : String(err)}`, "verify-permit", decision);
    }
    if (status >= 500) {
        throw new EnforceError(`verify-permit infrastructure failure (HTTP ${status})`, "verify-permit", decision);
    }
    if (status < 200 || status >= 300) {
        throw new EnforceError(`verify-permit failed (HTTP ${status})`, "verify-permit", decision);
    }
    let raw;
    try {
        raw = JSON.parse(body);
    }
    catch {
        throw new EnforceError("Non-JSON response from verify-permit", "verify-permit", decision);
    }
    if (raw.verified !== true) {
        // outcome=permit_consumed (replay), permit_expired, etc.
        throw new EnforceError(`Permit verification failed (outcome=${raw.outcome ?? "unknown"})`, "verify-permit", decision);
    }
    return { verified: true, outcome: raw.outcome };
}
// ---------------------------------------------------------------------------
// Step 4 — enforce (evaluate → verify → verifyPermit → execute, fail-closed)
// ---------------------------------------------------------------------------
async function enforce(config, fn) {
    const decision = await evaluate(config); // throws EnforceError → fn never runs
    verify(decision); // throws EnforceError → fn never runs
    const vp = await verifyPermit(config, decision); // throws EnforceError → fn never runs
    const result = await fn();
    return { result, decision, verifyOutcome: vp.outcome };
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function mapDecision(raw) {
    return {
        decision: raw["decision"],
        evaluationId: raw["evaluation_id"],
        permitToken: raw["permit_token"],
        proofHash: raw["proof_hash"],
        riskScore: extractRiskScore(raw),
        denyReason: raw["deny_reason"],
        holdReason: raw["hold_reason"],
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
    return undefined;
}
