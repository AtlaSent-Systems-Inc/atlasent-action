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

import { evaluate, verify, verifyPermit, EnforceError } from '@atlasent/enforce';
import type { Decision, EnforceConfig } from '@atlasent/enforce';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  /** Defaults to the raw HTTP body parsed as JSON. */
  [key: string]: unknown;
}

/**
 * Result returned to the caller for every webhook evaluation.
 * `decision` mirrors the AtlaSent decision. `verified` is true only when
 * decision=allow AND verifyPermit passed — callers MUST gate on `verified`,
 * not `decision` alone.
 */
export interface WebhookGuardResult {
  decision: 'allow' | 'deny' | 'hold' | 'escalate' | 'error';
  verified: boolean;
  /** Evaluation id for audit. Present on allow. */
  evaluationId?: string;
  /** Proof hash for tamper detection. Present on allow. */
  proofHash?: string;
  /** Risk score 0–100. Present when the API returns it. */
  riskScore?: number;
  /** Deny/hold reason from the policy engine. */
  reason?: string;
  /** The underlying EnforceError, if any. */
  error?: EnforceError;
}

/**
 * Extracts the three fields AtlaSent needs from an incoming webhook payload.
 * Callers may supply a custom extractor when the payload schema differs from
 * the default convention.
 */
export interface WebhookPayloadExtractor {
  (payload: WebhookPayload): {
    action_type: string;
    actor_id: string;
    context?: Record<string, unknown>;
  };
}

export interface WebhookGuardConfig {
  /** AtlaSent API key (ask_live_* or ask_test_*). */
  apiKey: string;
  /** Defaults to https://api.atlasent.io */
  apiUrl?: string;
  /**
   * How to extract action_type, actor_id, and context from the raw payload.
   * Defaults to reading payload.action_type / payload.actor_id / payload.context
   * (or payload.actor / payload.action as fallbacks).
   */
  extractor?: WebhookPayloadExtractor;
  /**
   * When true (default), the Express middleware responds with 403 on deny/hold
   * and 500 on infra errors. Set to false to let the caller handle all responses.
   */
  failClosed?: boolean;
  /** Optional environment string forwarded to AtlaSent. */
  environment?: string;
}

// Minimal request/response interfaces compatible with Express and Hono.
export interface WebhookRequest {
  body?: WebhookPayload;
}
export interface WebhookResponse {
  status(code: number): WebhookResponse;
  json(body: unknown): void;
}
export type WebhookNext = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Default payload extractor
// ---------------------------------------------------------------------------

const defaultExtractor: WebhookPayloadExtractor = (payload) => {
  const action_type =
    (payload['action_type'] as string | undefined) ??
    (payload['action'] as string | undefined) ??
    'unknown';
  const actor_id =
    (payload['actor_id'] as string | undefined) ??
    (payload['actor'] as string | undefined) ??
    'unknown';
  const context =
    (payload['context'] as Record<string, unknown> | undefined) ?? {};
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
async function evaluateWebhookPayload(
  payload: WebhookPayload,
  config: WebhookGuardConfig,
): Promise<WebhookGuardResult> {
  const extractor = config.extractor ?? defaultExtractor;
  const { action_type, actor_id, context } = extractor(payload);

  const enforceConfig: EnforceConfig = {
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

  let decision: Decision;
  try {
    decision = await evaluate(enforceConfig);
  } catch (err) {
    if (err instanceof EnforceError) {
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
    const reason =
      decision.denyReason ??
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
    verify(decision);
    await verifyPermit(enforceConfig, decision);
  } catch (err) {
    if (err instanceof EnforceError) {
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

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

export interface WebhookGuard {
  /**
   * Evaluate a raw payload. Returns a WebhookGuardResult.
   * Never throws (infra errors surface as decision='error').
   */
  evaluate(payload: WebhookPayload): Promise<WebhookGuardResult>;

  /**
   * Express/Hono-compatible middleware. Blocks the request (403/500) on
   * deny/hold/error when failClosed=true (the default). Attaches the result
   * to req.atlasent so downstream handlers can read it.
   */
  middleware(
    req: WebhookRequest & { atlasent?: WebhookGuardResult },
    res: WebhookResponse,
    next: WebhookNext,
  ): Promise<void>;
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
export function webhookGuard(config: WebhookGuardConfig): WebhookGuard {
  const failClosed = config.failClosed !== false; // default true

  async function evaluate_(payload: WebhookPayload): Promise<WebhookGuardResult> {
    return evaluateWebhookPayload(payload, config);
  }

  async function middleware(
    req: WebhookRequest & { atlasent?: WebhookGuardResult },
    res: WebhookResponse,
    next: WebhookNext,
  ): Promise<void> {
    const payload: WebhookPayload = req.body ?? {};
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
        } else {
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
