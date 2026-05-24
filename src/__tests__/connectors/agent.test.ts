import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentGuard, AgentGuardError, agentGuard } from '../../connectors/agent';
import type { AgentTool } from '../../connectors/agent';

// ---------------------------------------------------------------------------
// Mock @atlasent/enforce so no real HTTP calls are made.
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
    evaluationId: 'ev-agent-1',
    permitToken: 'tok-agent-1',
    proofHash: 'ph-agent-1',
    riskScore: 5,
    ...overrides,
  };
}

function makeTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  returnValue: unknown = 'tool-result',
  useInvoke = false,
): AgentTool<TArgs> {
  if (useInvoke) {
    return {
      name,
      description: `Tool: ${name}`,
      invoke: vi.fn().mockResolvedValue(returnValue),
    };
  }
  return {
    name,
    description: `Tool: ${name}`,
    call: vi.fn().mockResolvedValue(returnValue),
  };
}

beforeEach(() => {
  mockEvaluate.mockReset();
  mockVerify.mockReset();
  mockVerifyPermit.mockReset();
});

// ── AgentGuard.call() ────────────────────────────────────────────────────────

describe('AgentGuard.call()', () => {
  it('executes the tool when decision=allow and verifyPermit succeeds', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('web_search', { results: ['a'] });
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    const result = await guard.call(tool, { query: 'hello' });

    expect(result).toEqual({ results: ['a'] });
    expect(tool.call).toHaveBeenCalledWith({ query: 'hello' });
  });

  it('works with tools that use .invoke() instead of .call()', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('code_exec', 'output', true);
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    const result = await guard.call(tool, { code: 'print(1)' });

    expect(result).toBe('output');
    expect(tool.invoke).toHaveBeenCalledWith({ code: 'print(1)' });
  });

  it('throws AgentGuardError with decision=deny on deny', async () => {
    mockEvaluate.mockResolvedValueOnce({
      decision: 'deny',
      evaluationId: 'ev-deny',
      denyReason: 'not allowed by policy',
    });

    const tool = makeTool('delete_database');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });

    await expect(guard.call(tool, {})).rejects.toThrow(AgentGuardError);
    await expect(guard.call(tool, {})).rejects.toMatchObject({
      decision: 'deny',
      toolName: 'delete_database',
    });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('throws AgentGuardError with decision=hold on hold (blockOnHold=true, default)', async () => {
    mockEvaluate.mockResolvedValueOnce({
      decision: 'hold',
      evaluationId: 'ev-hold',
      holdReason: 'pending approval',
    });

    const tool = makeTool('send_email');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });

    await expect(guard.call(tool, {})).rejects.toThrow(AgentGuardError);
    await expect(guard.call(tool, {})).rejects.toMatchObject({
      decision: 'hold',
      toolName: 'send_email',
    });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('executes the tool on hold when blockOnHold=false', async () => {
    mockEvaluate
      .mockResolvedValueOnce({
        decision: 'hold',
        evaluationId: 'ev-hold',
        holdReason: 'pending approval',
      });

    const tool = makeTool('read_log', 'log-contents');
    const guard = new AgentGuard({ apiKey: 'ask_test_key', blockOnHold: false });
    const result = await guard.call(tool, {});

    expect(result).toBe('log-contents');
    expect(tool.call).toHaveBeenCalled();
  });

  it('throws AgentGuardError with decision=escalate on escalate', async () => {
    mockEvaluate.mockResolvedValueOnce({ decision: 'escalate', evaluationId: 'ev-esc' });

    const tool = makeTool('deploy_prod');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });

    await expect(guard.call(tool, {})).rejects.toMatchObject({
      decision: 'escalate',
      toolName: 'deploy_prod',
    });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('throws AgentGuardError with decision=error on infra failure', async () => {
    mockEvaluate.mockRejectedValueOnce(
      new EnforceError('AtlaSent API unreachable: timeout', 'evaluate'),
    );

    const tool = makeTool('any_tool');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });

    await expect(guard.call(tool, {})).rejects.toMatchObject({
      decision: 'error',
      toolName: 'any_tool',
    });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('throws AgentGuardError with decision=error on verifyPermit failure (fail-closed)', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockRejectedValueOnce(
      new EnforceError('Permit verification failed (outcome=permit_consumed)', 'verify-permit', allowDecision()),
    );

    const tool = makeTool('exec_tool');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });

    await expect(guard.call(tool, {})).rejects.toMatchObject({
      decision: 'error',
      toolName: 'exec_tool',
    });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('propagates unexpected (non-EnforceError) errors from evaluate', async () => {
    mockEvaluate.mockRejectedValueOnce(new TypeError('network split'));

    const tool = makeTool('any_tool');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });

    await expect(guard.call(tool, {})).rejects.toThrow('network split');
  });

  it('throws when tool has neither .call() nor .invoke()', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool: AgentTool = { name: 'broken', description: 'no executor' };
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });

    await expect(guard.call(tool, {})).rejects.toThrow(/neither .call\(\) nor .invoke\(\)/);
  });

  it('forwards agentId as actor prefix in EnforceConfig', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('search');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    await guard.call(tool, {}, { agentId: 'planner-v2', sessionId: 'sess-99' });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'agent:planner-v2',
        context: expect.objectContaining({
          source: 'ai-agent',
          tool_name: 'search',
          agent_id: 'planner-v2',
          session_id: 'sess-99',
        }),
      }),
    );
  });

  it('uses userId as actor when agentId is absent', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('file_read');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    await guard.call(tool, {}, { userId: 'bob' });

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'user:bob' }),
    );
  });

  it('falls back to defaultActorId when no context actor', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('list_files');
    const guard = new AgentGuard({ apiKey: 'ask_test_key', defaultActorId: 'service:worker' });
    await guard.call(tool, {});

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'service:worker' }),
    );
  });

  it('defaults to agent:unknown when no actor can be resolved', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('noop');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    await guard.call(tool, {});

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'agent:unknown' }),
    );
  });

  it('sends tool.name as the action to AtlaSent', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('web_browser');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    await guard.call(tool, {});

    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'web_browser' }),
    );
  });
});

// ── AgentGuard.wrap() ────────────────────────────────────────────────────────

describe('AgentGuard.wrap()', () => {
  it('wraps a tool so .call() is guarded automatically', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const tool = makeTool('search', 'results');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    const wrapped = guard.wrap(tool, { agentId: 'planner' });

    const result = await wrapped.call({ query: 'atlas' });
    expect(result).toBe('results');
  });

  it('preserves tool.name and tool.description on the wrapped object', () => {
    const tool = makeTool('my_tool');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    const wrapped = guard.wrap(tool);

    expect(wrapped.name).toBe('my_tool');
    expect(wrapped.description).toBe('Tool: my_tool');
  });

  it('blocks on deny via wrapped .call()', async () => {
    mockEvaluate.mockResolvedValueOnce({ decision: 'deny', denyReason: 'blocked' });

    const tool = makeTool('dangerous_tool');
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    const wrapped = guard.wrap(tool);

    await expect(wrapped.call({})).rejects.toThrow(AgentGuardError);
    expect(tool.call).not.toHaveBeenCalled();
  });
});

// ── AgentGuard.wrapAll() ─────────────────────────────────────────────────────

describe('AgentGuard.wrapAll()', () => {
  it('wraps every tool in the array', async () => {
    mockEvaluate.mockResolvedValue(allowDecision());
    mockVerify.mockReturnValue(undefined);
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: 'ok' });

    const tools = [makeTool('tool_a', 'a'), makeTool('tool_b', 'b')];
    const guard = new AgentGuard({ apiKey: 'ask_test_key' });
    const wrapped = guard.wrapAll(tools, { agentId: 'executor' });

    expect(wrapped).toHaveLength(2);
    const r0 = await wrapped[0].call({});
    const r1 = await wrapped[1].call({});
    expect(r0).toBe('a');
    expect(r1).toBe('b');
  });
});

// ── agentGuard() factory ─────────────────────────────────────────────────────

describe('agentGuard() factory', () => {
  it('returns a factory with .call(), .wrap(), .wrapAll(), and .guard', async () => {
    mockEvaluate.mockResolvedValueOnce(allowDecision());
    mockVerify.mockReturnValueOnce(undefined);
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: 'ok' });

    const factory = agentGuard({ apiKey: 'ask_test_key' });
    expect(typeof factory.call).toBe('function');
    expect(typeof factory.wrap).toBe('function');
    expect(typeof factory.wrapAll).toBe('function');
    expect(factory.guard).toBeInstanceOf(AgentGuard);

    const tool = makeTool('noop', 'done');
    const result = await factory.call(tool, {}, { agentId: 'test-agent' });
    expect(result).toBe('done');
  });

  it('blocks on deny via factory.call()', async () => {
    mockEvaluate.mockResolvedValueOnce({ decision: 'deny', denyReason: 'blocked' });

    const factory = agentGuard({ apiKey: 'ask_test_key' });
    const tool = makeTool('risky_tool');

    await expect(factory.call(tool, {})).rejects.toMatchObject({
      decision: 'deny',
      toolName: 'risky_tool',
    });
  });
});

// ── AgentGuardError ──────────────────────────────────────────────────────────

describe('AgentGuardError', () => {
  it('is an instance of Error with the correct fields', () => {
    const err = new AgentGuardError('tool blocked', 'deny', 'my_tool', 'ev-123');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentGuardError);
    expect(err.name).toBe('AgentGuardError');
    expect(err.message).toBe('tool blocked');
    expect(err.decision).toBe('deny');
    expect(err.toolName).toBe('my_tool');
    expect(err.evaluationId).toBe('ev-123');
  });

  it('evaluationId is undefined when not provided', () => {
    const err = new AgentGuardError('denied', 'deny', 'tool');
    expect(err.evaluationId).toBeUndefined();
  });
});
