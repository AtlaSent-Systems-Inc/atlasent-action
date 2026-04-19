import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMock = {
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
};

vi.mock('@actions/core', () => coreMock);

function setInputs(inputs: Record<string, string>, failOnDeny = true): void {
  coreMock.getInput.mockImplementation((name: string) => inputs[name] ?? '');
  coreMock.getBooleanInput.mockImplementation((name: string) => (name === 'fail-on-deny' ? failOnDeny : false));
}

function mockFetchJson(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      statusText: ok ? 'OK' : 'Internal Server Error',
      json: async () => body,
    })),
  );
}

const baseInputs = {
  'atlasent-api-url': 'https://api.atlasent.io',
  'atlasent-api-key': 'secret',
  'action-id': 'ci.production-deploy',
};

describe('run()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('sets outputs and does not fail on allow', async () => {
    setInputs(baseInputs);
    mockFetchJson({
      decision: 'allow',
      risk: { level: 'low', score: 10 },
      id: 'eval_123',
      permitId: 'permit_abc',
    });

    const { run } = await import('./main');
    await run();

    expect(coreMock.setOutput).toHaveBeenCalledWith('decision', 'allow');
    expect(coreMock.setOutput).toHaveBeenCalledWith('risk-level', 'low');
    expect(coreMock.setOutput).toHaveBeenCalledWith('evaluation-id', 'eval_123');
    expect(coreMock.setOutput).toHaveBeenCalledWith('permit-id', 'permit_abc');
    expect(coreMock.setFailed).not.toHaveBeenCalled();
  });

  it('fails the step on deny when fail-on-deny is true', async () => {
    setInputs(baseInputs, true);
    mockFetchJson({
      decision: 'deny',
      risk: { level: 'high', score: 85 },
      id: 'eval_456',
    });

    const { run } = await import('./main');
    await run();

    expect(coreMock.setFailed).toHaveBeenCalledTimes(1);
    expect(coreMock.setFailed.mock.calls[0][0]).toMatch(/denied action "ci\.production-deploy"/);
    expect(coreMock.setFailed.mock.calls[0][0]).toMatch(/high \(85\/100\)/);
  });

  it('warns but does not fail on deny when fail-on-deny is false', async () => {
    setInputs(baseInputs, false);
    mockFetchJson({
      decision: 'deny',
      risk: { level: 'medium', score: 55 },
    });

    const { run } = await import('./main');
    await run();

    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/denied action/);
  });

  it('warns on require_approval', async () => {
    setInputs(baseInputs);
    mockFetchJson({
      decision: 'require_approval',
      risk: { level: 'medium', score: 40 },
      permitId: 'permit_xyz',
    });

    const { run } = await import('./main');
    await run();

    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/requires approval/);
    expect(coreMock.warning.mock.calls[0][0]).toMatch(/permit_xyz/);
  });

  it('fails closed on non-ok HTTP response', async () => {
    setInputs(baseInputs);
    mockFetchJson({ message: 'unauthorized' }, false, 401);

    const { run } = await import('./main');
    await run();

    expect(coreMock.setFailed).toHaveBeenCalledTimes(1);
    expect(coreMock.setFailed.mock.calls[0][0]).toMatch(/AtlaSent evaluation failed/);
    expect(coreMock.setFailed.mock.calls[0][0]).toMatch(/401/);
  });

  it('fails closed on network error', async () => {
    setInputs(baseInputs);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const { run } = await import('./main');
    await run();

    expect(coreMock.setFailed).toHaveBeenCalledTimes(1);
    expect(coreMock.setFailed.mock.calls[0][0]).toMatch(/ECONNREFUSED/);
  });
});
