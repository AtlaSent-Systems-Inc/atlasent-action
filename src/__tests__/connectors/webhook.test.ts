import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webhookGuard } from '../../connectors/webhook';
import type { WebhookGuardResult } from '../../connectors/webhook';

// ---------------------------------------------------------------------------
// Mock @atlasent/enforce so no real HTTP calls are made.
// We keep EnforceError as the real class so instanceof checks work.
// ---------------------------------------------------------------------------

vi.mock('@atlasent/enforce', async (importOriginal) => {
  const original = await importOriginal<typeof import('@atlasent/enforce')>();
  return {
    ...original,
    evaluate: vi.fn(),
    verify: vi.fn(),
    verifyPermit: vi.fn(),
  };
});

import { evaluate, verify, verifyPermit, EnforceError } from '@atlasent/enforce';
import type { Decision } from '@atlasent/enforce';

const mockEvaluate = evaluate as ReturnType<typeof vi.fn>;
const mockVerify = verify as ReturnType<typeof vi.fn>;
const mockVerifyPermit = verifyPermit as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allowDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    decision: 'allow',
    evaluationId: 'ev-1',
    permitToken: 'tok-1',
    proofHash: 'ph-1',
    riskScore: 10,
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
    },
  };
  return res;
}

function makeReq(body: Record<string, unknown> = {}) {
  return { body, atlasent: undefined as WebhookGuardResult | undefined };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockEvaluate.mockReset();
  mockVerify.mockReset();
  mockVerifyPermit.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── evaluate() ──────────────────────────────────────────────────────────────

describe('webhookGuard.evaluate()', () => {
  it('returns verified=true on allow + verifyPermit success', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const result = await guard.evaluate({
      action_type: 'production.deploy',
      actor_id: 'user:alice',
    });

    expect(result.decision).toBe('allow');
    expect(result.verified).toBe(true);
    expect(result.evaluationId).toBe('ev-1');
    expect(result.proofHash).toBe('ph-1');
    expect(result.riskScore).toBe(10);
  });

  it('returns verified=false and decision=error when verifyPermit fails', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockRejectedValueOnce(
      new EnforceError('Permit verification failed (outcome=permit_consumed)', 'verify-permit', allowDecision()),
    );

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const result = await guard.evaluate({ action_type: 'production.deploy', actor_id: 'u' });

    expect(result.decision).toBe('error');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('permit_consumed');
  });

  it('returns decision=deny with reason on deny', async () => {
    mockEvaluate.mockResolvedValueOnce({
      decision: 'deny',
      evaluationId: 'ev-deny',
      denyReason: 'change window closed',
    });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const result = await guard.evaluate({ action_type: 'production.deploy', actor_id: 'u' });

    expect(result.decision).toBe('deny');
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('change window closed');
    expect(mockVerifyPermit).not.toHaveBeenCalled();
  });

  it('returns decision=hold with reason on hold', async () => {
    mockEvaluate.mockResolvedValueOnce({
      decision: 'hold',
      evaluationId: 'ev-hold',
      holdReason: 'awaiting manager approval',
    });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const result = await guard.evaluate({ action_type: 'deploy', actor_id: 'u' });

    expect(result.decision).toBe('hold');
    expect(result.reason).toBe('awaiting manager approval');
    expect(mockVerifyPermit).not.toHaveBeenCalled();
  });

  it('returns decision=error on infra failure (EnforceError from evaluate)', async () => {
    mockEvaluate.mockRejectedValueOnce(
      new EnforceError('AtlaSent API unreachable: ECONNREFUSED', 'evaluate'),
    );

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const result = await guard.evaluate({ action_type: 'deploy', actor_id: 'u' });

    expect(result.decision).toBe('error');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
    expect(result.error).toBeInstanceOf(EnforceError);
  });

  it('propagates unexpected (non-EnforceError) errors', async () => {
    mockEvaluate.mockRejectedValueOnce(new TypeError('unexpected'));

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    await expect(
      guard.evaluate({ action_type: 'deploy', actor_id: 'u' }),
    ).rejects.toThrow('unexpected');
  });

  it('uses custom extractor when provided', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const guard = webhookGuard({
      apiKey: 'ask_test_key',
      extractor: (payload) => ({
        action_type: payload['type'] as string,
        actor_id: `user:${payload['user'] as string}`,
        context: { repo: payload['repo'] },
      }),
    });

    await guard.evaluate({ type: 'production.deploy', user: 'alice', repo: 'api' });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'production.deploy',
        actor: 'user:alice',
        context: expect.objectContaining({ repo: 'api' }),
      }),
    );
  });

  it('uses default extractor fallbacks (action/actor fields)', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    await guard.evaluate({ action: 'production.deploy', actor: 'bot:ci' });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'production.deploy', actor: 'bot:ci' }),
    );
  });

  it('forwards environment to EnforceConfig when set', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const guard = webhookGuard({ apiKey: 'ask_test_key', environment: 'live' });
    await guard.evaluate({ action_type: 'deploy', actor_id: 'u' });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'live' }),
    );
  });

  it('embeds source=webhook in context', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    await guard.evaluate({ action_type: 'deploy', actor_id: 'u', context: { repo: 'x' } });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ source: 'webhook', repo: 'x' }),
      }),
    );
  });
});

// ── middleware ───────────────────────────────────────────────────────────────

describe('webhookGuard.middleware', () => {
  it('calls next() on allow + verified=true', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const req = makeReq({ action_type: 'production.deploy', actor_id: 'u' });
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.atlasent?.decision).toBe('allow');
    expect(req.atlasent?.verified).toBe(true);
  });

  it('responds 403 on deny without calling next()', async () => {
    mockEvaluate.mockResolvedValueOnce({ decision: 'deny', denyReason: 'policy' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const req = makeReq({ action_type: 'deploy', actor_id: 'u' });
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as Record<string, unknown>)['decision']).toBe('deny');
  });

  it('responds 403 on hold without calling next()', async () => {
    mockEvaluate.mockResolvedValueOnce({ decision: 'hold', holdReason: 'approval needed' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('responds 403 on escalate without calling next()', async () => {
    mockEvaluate.mockResolvedValueOnce({ decision: 'escalate' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('responds 500 on infra error without calling next()', async () => {
    mockEvaluate.mockRejectedValueOnce(
      new EnforceError('API unreachable', 'evaluate'),
    );

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(500);
  });

  it('responds 403 when allow but verified=false (permit verification failed)', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockRejectedValueOnce(
      new EnforceError('Permit verification failed', 'verify-permit', allowDecision()),
    );

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const req = makeReq({ action_type: 'deploy', actor_id: 'u' });
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('calls next() on all decisions when failClosed=false', async () => {
    mockEvaluate.mockResolvedValueOnce({ decision: 'deny', denyReason: 'policy' });

    const guard = webhookGuard({ apiKey: 'ask_test_key', failClosed: false });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.atlasent?.decision).toBe('deny');
  });

  it('uses an empty object when req.body is undefined', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const guard = webhookGuard({ apiKey: 'ask_test_key' });
    const req: { body?: Record<string, unknown>; atlasent?: WebhookGuardResult } = { atlasent: undefined };
    const res = makeRes();
    const next = vi.fn();

    await guard.middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
