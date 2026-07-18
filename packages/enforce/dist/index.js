"use strict";
// @atlasent/enforce — fail-closed execution wrapper.
//
// Enforces the evaluate → verify → verifyPermit → execute contract:
//   1. evaluate()     — calls POST /v1-evaluate; any infra error blocks execution
//   2. verify()       — rejects non-allow decisions (deny / hold / escalate)
//   3. verifyPermit() — calls POST /v1-verify-permit; replay/expired tokens block
//   4. enforce()      — composes all three; fn never runs unless all steps pass
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnforceError = void 0;
exports.evaluate = evaluate;
exports.verify = verify;
exports.requiredBindingsFor = requiredBindingsFor;
exports.verifyPermit = verifyPermit;
exports.reverifyPermit = reverifyPermit;
exports.enforce = enforce;
const transport_1 = require("./transport");
const DEFAULT_API_URL = "https://api.atlasent.io";
class EnforceError extends Error {
    phase;
    decision;
    /** Coarse verify outcome (verified | mismatch | expired | replay_blocked | invalid | …). */
    outcome;
    /** Precise verify wire code, when the failure came from verify-permit. */
    verifyErrorCode;
    mismatchFields;
    constructor(message, phase, decision = null, details) {
        super(message);
        this.name = "EnforceError";
        this.phase = phase;
        this.decision = decision;
        this.outcome = details?.outcome;
        this.verifyErrorCode = details?.verifyErrorCode;
        this.mismatchFields = details?.mismatchFields;
    }
}
exports.EnforceError = EnforceError;
// ---------------------------------------------------------------------------
// Step 1 — evaluate
// ---------------------------------------------------------------------------
async function evaluate(config) {
    const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    // Separate state_snapshot out of context if the caller mistakenly nested it there.
    const rawContext = { ...config.context };
    const contextSnapshot = rawContext["state_snapshot"];
    delete rawContext["state_snapshot"];
    const payload = {
        action_type: config.action,
        actor_id: config.actor,
        context: {
            // Keep environment in context for backward compat with older control plane versions.
            ...(config.environment ? { environment: config.environment } : {}),
            ...(config.targetId ? { target_id: config.targetId } : {}),
            ...rawContext,
        },
    };
    // Top-level fields forwarded to the control plane's EvaluateRequest.
    if (config.environment != null)
        payload["environment"] = config.environment;
    if (config.resource != null)
        payload["resource"] = config.resource;
    else if (config.targetId)
        payload["target_id"] = config.targetId;
    if (config.current_state != null)
        payload["current_state"] = config.current_state;
    if (config.proposed_state != null)
        payload["proposed_state"] = config.proposed_state;
    if (config.execution_binding != null)
        payload["execution_binding"] = config.execution_binding;
    // state_snapshot is a top-level body field (EvaluateBody.state_snapshot), not inside context.
    const snap = config.state_snapshot ?? contextSnapshot;
    if (snap != null)
        payload["state_snapshot"] = snap;
    // Artifact digest is a canonical top-level input — the runtime binds it into
    // the permit (execution_hash_expected). Never buried in context/presentation.
    if (config.executionPayloadHash != null) {
        payload["execution_payload_hash"] = config.executionPayloadHash;
    }
    let status;
    let body;
    try {
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1-evaluate`, JSON.stringify(payload), {
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
/**
 * Shared HTTP core for permit verification. Sends the permit token AND re-binds
 * the execution context (environment, target, artifact digest) so verification
 * checks the caller is executing the SAME artifact/environment the permit was
 * issued for. Returns a normalized result (does not throw on verified=false —
 * the caller applies the fail-closed decision).
 */
async function postVerify(config, permitToken, decision) {
    const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    const bodyObj = {
        permit_token: permitToken,
        action_type: config.action,
        actor_id: config.actor,
    };
    if (config.environment != null)
        bodyObj["environment"] = config.environment;
    if (config.targetId != null)
        bodyObj["target_id"] = config.targetId;
    // Prefer the runtime-bound original evaluated digest (execution_hash_expected,
    // echoed on the decision) over a caller-supplied one, so verify re-presents the
    // artifact the permit was actually issued for — not one re-supplied at verify time.
    const payloadHash = decision?.executionHashExpected ?? config.executionPayloadHash;
    if (payloadHash != null)
        bodyObj["payload_hash"] = payloadHash;
    // Fail closed: if the caller declared bindings as required, refuse to verify —
    // BEFORE the network round-trip — when any is absent or empty. A permit gate that
    // silently drops its environment / target / artifact binding is the exact
    // substitution hole this closes. verify-error-code MISSING_BINDING.
    const missing = (config.requiredBindings ?? []).filter((b) => bodyObj[b] == null || bodyObj[b] === "");
    if (missing.length > 0) {
        throw new EnforceError(`verify-permit refused: required binding(s) absent: ${missing.join(", ")}`, "verify-permit", decision, { outcome: "invalid", verifyErrorCode: "MISSING_BINDING" });
    }
    let status;
    let body;
    try {
        ({ status, body } = await (0, transport_1.post)(`${apiUrl}/v1-verify-permit`, JSON.stringify(bodyObj), {
            Authorization: `Bearer ${config.apiKey}`,
        }));
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
    // Runtime wire field is `valid`; older responses used `verified`. Accept both.
    const ok = raw.valid ?? raw.verified;
    return {
        verified: ok === true,
        outcome: raw.outcome,
        verifyErrorCode: raw.verify_error_code,
        mismatchFields: Array.isArray(raw.mismatch_fields) ? raw.mismatch_fields : undefined,
    };
}
/**
 * Derive the `requiredBindings` set from the bindings actually provided for a
 * decision/item — "re-present at verify exactly what was bound at evaluate."
 * A binding that is present at evaluate but absent at verify then fails closed
 * (MISSING_BINDING) instead of silently dropping off the wire. Empty strings do
 * not count as present.
 */
function requiredBindingsFor(b) {
    const r = [];
    if (b.environment != null && b.environment !== "")
        r.push("environment");
    if (b.targetId != null && b.targetId !== "")
        r.push("target_id");
    if (b.executionPayloadHash != null && b.executionPayloadHash !== "")
        r.push("payload_hash");
    return r;
}
async function verifyPermit(config, decision) {
    if (!decision.permitToken) {
        throw new EnforceError("evaluate returned allow but no permit_token — refusing to execute without verifiable permit", "verify-permit", decision);
    }
    const r = await postVerify(config, decision.permitToken, decision);
    if (!r.verified) {
        // outcome=replay_blocked (replay), expired, mismatch (wrong artifact/env), etc.
        throw new EnforceError(`Permit verification failed (outcome=${r.outcome ?? "unknown"}${r.verifyErrorCode ? `, code=${r.verifyErrorCode}` : ""})`, "verify-permit", decision, { outcome: r.outcome, verifyErrorCode: r.verifyErrorCode, mismatchFields: r.mismatchFields });
    }
    return r;
}
// ---------------------------------------------------------------------------
// Step 3b — reverifyPermit (re-verify at the EXECUTION BOUNDARY)
//
// Re-verify an already-issued permit immediately before the protected step,
// independent of the gate that issued it — so a workflow cannot evaluate one
// artifact and execute another, and a missing / modified / expired / replayed /
// context-mismatched permit fails closed AT THE BOUNDARY. Pass the artifact
// digest via config.executionPayloadHash and the environment via config.environment.
// ---------------------------------------------------------------------------
async function reverifyPermit(config, permitToken) {
    if (!permitToken || !permitToken.trim()) {
        throw new EnforceError("no permit_token presented at execution boundary — refusing to execute", "verify-permit", null, { outcome: "invalid", verifyErrorCode: "MISSING_PERMIT" });
    }
    const r = await postVerify(config, permitToken, null);
    if (!r.verified) {
        throw new EnforceError(`Permit re-verification failed at execution boundary (outcome=${r.outcome ?? "unknown"}${r.verifyErrorCode ? `, code=${r.verifyErrorCode}` : ""})`, "verify-permit", null, { outcome: r.outcome, verifyErrorCode: r.verifyErrorCode, mismatchFields: r.mismatchFields });
    }
    return r;
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
        executionHashExpected: (raw["execution_hash_expected"] ?? raw["payload_hash"]),
        riskScore: extractRiskScore(raw),
        denyReason: raw["deny_reason"],
        denyCode: raw["deny_code"],
        remediation: raw["remediation"],
        holdReason: raw["hold_reason"],
        risk_class: raw["risk_class"],
        authority_basis: raw["authority_basis"],
        escalation_id: raw["escalation_id"],
        chainEntry: raw["chain_entry"] ?? null,
        snapshot: raw["snapshot"] ?? null,
        auditHash: raw["audit_hash"],
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
