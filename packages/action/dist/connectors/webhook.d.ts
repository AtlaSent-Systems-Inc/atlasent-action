import { EnforceError } from '@atlasent/enforce';
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
export interface WebhookRequest {
    body?: WebhookPayload;
}
export interface WebhookResponse {
    status(code: number): WebhookResponse;
    json(body: unknown): void;
}
export type WebhookNext = (err?: unknown) => void;
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
    middleware(req: WebhookRequest & {
        atlasent?: WebhookGuardResult;
    }, res: WebhookResponse, next: WebhookNext): Promise<void>;
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
export declare function webhookGuard(config: WebhookGuardConfig): WebhookGuard;
