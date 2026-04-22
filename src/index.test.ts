import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import * as core from '@actions/core';
import { run } from './index.ts';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function setupInputs(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    'atlasent-api-url': 'https://api.example.atlasent',
    'atlasent-api-key': 'test-key',
    'action-id': 'ci.deploy',
    'actor-id': 'actor',
    'target-id': 'org/repo',
    'environment': 'staging',
    'context': '{}',
    'fail-on-deny': 'true',
  };
  const merged = { ...defaults, ...overrides };
  vi.mocked(core.getInput).mockImplementation((name: string) => merged[name] ?? '');
  vi.mocked(core.getBooleanInput).mockImplementation((name: string) => merged[name] === 'true');
}

function mockResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  });
}

describe('atlasent-action run()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allow: sets all outputs, no failure', async () => {
    setupInputs();
    mockResponse({ decision: 'allow', risk: { level: 'low', score: 5 }, id: 'e1', permitId: 'p1' });
    await run();
    expect(core.setOutput).toHaveBeenCalledWith('decision', 'allow');
    expect(core.setOutput).toHaveBeenCalledWith('risk-level', 'low');
    expect(core.setOutput).toHaveBeenCalledWith('risk-score', '5');
    expect(core.setOutput).toHaveBeenCalledWith('evaluation-id', 'e1');
    expect(core.setOutput).toHaveBeenCalledWith('permit-id', 'p1');
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('deny + fail-on-deny=true: calls setFailed', async () => {
    setupInputs({ 'fail-on-deny': 'true' });
    mockResponse({ decision: 'deny', risk: { level: 'high', score: 85 }, id: 'e2' });
    await run();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });

  it('deny + fail-on-deny=false: calls warning, no failure', async () => {
    setupInputs({ 'fail-on-deny': 'false' });
    mockResponse({ decision: 'deny', risk: { level: 'medium', score: 55 }, id: 'e3' });
    await run();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('denied'));
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('require_approval: calls warning, no failure', async () => {
    setupInputs({ 'fail-on-deny': 'false' });
    mockResponse({ decision: 'require_approval', risk: { level: 'medium', score: 60 }, id: 'e4', permitId: 'p4' });
    await run();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('approval'));
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('API non-2xx: calls setFailed with status', async () => {
    setupInputs();
    mockResponse({ message: 'Unauthorized' }, 401);
    await run();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('401'));
  });

  it('network failure: calls setFailed with error message', async () => {
    setupInputs();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await run();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});
