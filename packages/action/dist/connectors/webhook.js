"use strict";
// Phase B7 — Webhook connector.
//
// Implements the same evaluate → verify → verifyPermit contract as the
// GitHub Actions reference connector (src/index.ts), adapted for
// incoming webhook payloads in any Express/Hono/Node.js http server.
//
// Usage:
//
//   import { webhookGuard } from '@atlasent/action/connectors';
//
//   const guard = webhookGuard({ apiKey: process.env.ATLASENT_API_KEY });
//
//   // Express:
//   app.post('/hooks/deploy', guard, (req, res) => {
//     res.json({ status: 'executed' });
//   });
//
//   // Standalone (Hono, raw Node, etc.):
//   const result = await guard.evaluate(payload);
//   if (result.decision !== 'allow') { /* block */ }
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookGuard = webhookGuard;
const enforce_1 = require("@atlasent/enforce");
// ---------------------------------------------------------------------------
// Default payload extractor
// ---------------------------------------------------------------------------
const defaultExtractor = (payload) => {
    const action_type = payload['action_type'] ??
        payload['action'] ??
        'unknown';
    const actor_id = payload['actor_id'] ??
        payload['actor'] ??
        'unknown';
    const context = payload['context'] ?? {};
    return { action_type, actor_id, context };
};
// ---------------------------------------------------------------------------
// Core evaluate function
// ---------------------------------------------------------------------------
/**
 * Evaluate a webhook payload against AtlaSent.
 * Returns a WebhookGuardResult — callers decide what to do with hold.
 * Throws only on unexpected (non-EnforceError) errors.
 */
async function evaluateWebhookPayload(payload, config) {
    const extractor = config.extractor ?? defaultExtractor;
    const { action_type, actor_id, context } = extractor(payload);
    const enforceConfig = {
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        action: action_type,
        actor: actor_id,
        environment: config.environment,
        context: {
            source: 'webhook',
            ...context,
        },
    };
    let decision;
    try {
        decision = await (0, enforce_1.evaluate)(enforceConfig);
    }
    catch (err) {
        if (err instanceof enforce_1.EnforceError) {
            return {
                decision: 'error',
                verified: false,
                reason: err.message,
                error: err,
            };
        }
        throw err;
    }
    // Non-allow decisions: return immediately without verifyPermit.
    if (decision.decision !== 'allow') {
        const reason = decision.denyReason ??
            decision.holdReason ??
            (decision.decision === 'escalate' ? 'manual review required' : undefined);
        return {
            decision: decision.decision,
            verified: false,
            evaluationId: decision.evaluationId,
            riskScore: decision.riskScore,
            reason,
        };
    }
    // Allow: run verifyPermit (fail-closed — no permit token = block).
    try {
        (0, enforce_1.verify)(decision);
        await (0, enforce_1.verifyPermit)(enforceConfig, decision);
    }
    catch (err) {
        if (err instanceof enforce_1.EnforceError) {
            // Permit verification failed on an allow decision: treat as authorization
            // denied (403), not an infra error (500). The evaluation said allow but
            // the permit chain is invalid — caller must be blocked.
            return {
                decision: 'allow',
                verified: false,
                evaluationId: decision.evaluationId,
                reason: err.message,
                error: err,
            };
        }
        throw err;
    }
    return {
        decision: 'allow',
        verified: true,
        evaluationId: decision.evaluationId,
        proofHash: decision.proofHash,
        riskScore: decision.riskScore,
    };
}
/**
 * Create a webhook guard for the given AtlaSent configuration.
 *
 * @example
 * const guard = webhookGuard({ apiKey: process.env.ATLASENT_API_KEY });
 *
 * // Standalone:
 * const result = await guard.evaluate(req.body);
 *
 * // Express middleware:
 * app.post('/hooks/deploy', guard.middleware, handler);
 */
function webhookGuard(config) {
    const failClosed = config.failClosed !== false; // default true
    async function evaluate_(payload) {
        return evaluateWebhookPayload(payload, config);
    }
    async function middleware(req, res, next) {
        const payload = req.body ?? {};
        const result = await evaluateWebhookPayload(payload, config);
        req.atlasent = result;
        if (!failClosed) {
            next();
            return;
        }
        switch (result.decision) {
            case 'allow':
                if (result.verified) {
                    next();
                }
                else {
                    // allow without verified = permit verification failed (fail-closed).
                    res.status(403).json({
                        error: 'Authorization denied',
                        reason: result.reason ?? 'Permit verification failed',
                        decision: result.decision,
                    });
                }
                break;
            case 'deny':
                res.status(403).json({
                    error: 'Authorization denied',
                    reason: result.reason ?? 'Denied by policy',
                    decision: result.decision,
                });
                break;
            case 'hold':
                res.status(403).json({
                    error: 'Authorization on hold',
                    reason: result.reason ?? 'Awaiting approval',
                    decision: result.decision,
                });
                break;
            case 'escalate':
                res.status(403).json({
                    error: 'Authorization escalated',
                    reason: result.reason ?? 'Manual review required',
                    decision: result.decision,
                });
                break;
            case 'error':
            default:
                // Infrastructure error — fail-closed.
                res.status(500).json({
                    error: 'Authorization check failed',
                    reason: result.reason ?? 'Infrastructure error',
                });
                break;
        }
    }
    return { evaluate: evaluate_, middleware };
}
