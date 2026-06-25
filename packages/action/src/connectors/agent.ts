// Phase B7 — AI-agent connector.
//
// Guards LangChain-style tool execution against the AtlaSent runtime.
// Before any tool call, the guard evaluates the tool call against AtlaSent
// using the same evaluate → verify → verifyPermit contract as the GitHub
// Actions reference connector. Execution is blocked (throws AgentGuardError)
// when the decision is deny or hold.
//
// Usage:
//
//   import { AgentGuard, agentGuard } from '@atlasent/action/connectors';
//
//   // Class API:
//   const guard = new AgentGuard({ apiKey: process.env.ATLASENT_API_KEY });
//   const result = await guard.call(tool, args, { agentId: 'my-agent' });
//
//   // Factory + convenience wrapper:
//   const guard = agentGuard({ apiKey: process.env.ATLASENT_API_KEY });
//   const wrappedTool = guard.wrap(tool);
//   const result = await wrappedTool.call(args);

import { evaluate, verify, verifyPermit, EnforceError } from '@atlasent/enforce';
import type { Decision, EnforceConfig } from '@atlasent/enforce';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a LangChain-style tool.
 * Compatible with LangChain's BaseTool, StructuredTool, DynamicTool, and
 * any object with name + description + call/invoke.
 */
export interface AgentTool<TArgs = Record<string, unknown>, TReturn = unknown> {
  name: string;
  description: string;
  call?(args: TArgs): Promise<TReturn>;
  invoke?(args: TArgs): Promise<TReturn>;
  [key: string]: unknown;
}

/**
 * Context about the agent invocation, forwarded to AtlaSent as evaluation
 * context so policies can branch on agent identity, session, etc.
 */
export interface AgentCallContext {
  /** Identifier for the agent making the tool call. */
  agentId?: string;
  /** Session or conversation id. */
  sessionId?: string;
  /** Human user who initiated the agent session. */
  userId?: string;
  /** Additional freeform context. */
  [key: string]: unknown;
}

export interface AgentGuardConfig {
  /** AtlaSent API key (ask_live_* or ask_test_*). */
  apiKey: string;
  /** Defaults to https://api.atlasent.io */
  apiUrl?: string;
  /**
   * Default actor id forwarded to AtlaSent when no per-call actor is provided.
   * Defaults to 'agent:unknown'.
   */
  defaultActorId?: string;
  /** Optional environment string forwarded to AtlaSent. */
  environment?: string;
  /**
   * When true (default), hold decisions block execution. When false, hold
   * decisions are passed through and the caller decides what to do.
   */
  blockOnHold?: boolean;
}

/**
 * Thrown when AtlaSent denies or holds a tool call.
 * Callers should catch this and surface it appropriately in the agent loop.
 */
export class AgentGuardError extends Error {
  readonly decision: 'deny' | 'hold' | 'escalate' | 'error';
  readonly toolName: string;
  readonly evaluationId?: string;

  constructor(
    message: string,
    decision: 'deny' | 'hold' | 'escalate' | 'error',
    toolName: string,
    evaluationId?: string,
  ) {
    super(message);
    this.name = 'AgentGuardError';
    this.decision = decision;
    this.toolName = toolName;
    this.evaluationId = evaluationId;
  }
}

// ---------------------------------------------------------------------------
// AgentGuard class
// ---------------------------------------------------------------------------

export class AgentGuard {
  private readonly config: AgentGuardConfig;

  constructor(config: AgentGuardConfig) {
    this.config = config;
  }

  /**
   * Evaluate a tool call against AtlaSent, then execute the tool if allowed.
   *
   * @param tool   The tool to call. Must have `.name`, `.description`, and
   *               either `.call()` or `.invoke()`.
   * @param args   Arguments to pass to the tool.
   * @param ctx    Agent/session context forwarded to AtlaSent.
   * @returns      The tool's return value.
   * @throws       AgentGuardError when the decision is deny, hold, or an
   *               infrastructure error occurs (fail-closed).
   */
  async call<TArgs extends Record<string, unknown>, TReturn>(
    tool: AgentTool<TArgs, TReturn>,
    args: TArgs,
    ctx: AgentCallContext = {},
  ): Promise<TReturn> {
    const { config } = this;
    const blockOnHold = config.blockOnHold !== false; // default true

    const actorId =
      (ctx.agentId ? `agent:${ctx.agentId}` : null) ??
      (ctx.userId ? `user:${ctx.userId}` : null) ??
      config.defaultActorId ??
      'agent:unknown';

    const enforceConfig: EnforceConfig = {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      action: tool.name,
      actor: actorId,
      environment: config.environment,
      context: {
        source: 'ai-agent',
        tool_name: tool.name,
        tool_description: tool.description,
        ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
        ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
        ...(ctx.userId ? { user_id: ctx.userId } : {}),
        // Forward any extra context fields the caller supplied.
        ...Object.fromEntries(
          Object.entries(ctx).filter(
            ([k]) => !['agentId', 'sessionId', 'userId'].includes(k),
          ),
        ),
      },
    };

    let decision: Decision;
    try {
      decision = await evaluate(enforceConfig);
    } catch (err) {
      if (err instanceof EnforceError) {
        throw new AgentGuardError(
          `AtlaSent infra error evaluating tool "${tool.name}": ${err.message}`,
          'error',
          tool.name,
        );
      }
      throw err;
    }

    // Non-allow decisions.
    if (decision.decision === 'deny') {
      throw new AgentGuardError(
        `Tool "${tool.name}" denied: ${decision.denyReason ?? 'no reason provided'}`,
        'deny',
        tool.name,
        decision.evaluationId,
      );
    }
    if (decision.decision === 'escalate') {
      throw new AgentGuardError(
        `Tool "${tool.name}" escalated — manual review required`,
        'escalate',
        tool.name,
        decision.evaluationId,
      );
    }
    if (decision.decision === 'hold') {
      if (blockOnHold) {
        throw new AgentGuardError(
          `Tool "${tool.name}" on hold: ${decision.holdReason ?? 'awaiting approval'}`,
          'hold',
          tool.name,
          decision.evaluationId,
        );
      }
      // blockOnHold=false: fall through and execute anyway (caller's choice).
    }

    // Allow: run verifyPermit before executing (fail-closed).
    if (decision.decision === 'allow') {
      try {
        verify(decision);
        await verifyPermit(enforceConfig, decision);
      } catch (err) {
        if (err instanceof EnforceError) {
          throw new AgentGuardError(
            `AtlaSent permit verification failed for tool "${tool.name}": ${err.message}`,
            'error',
            tool.name,
            decision.evaluationId,
          );
        }
        throw err;
      }
    }

    // Execute the tool.
    const fn = tool.call ?? tool.invoke;
    if (!fn) {
      throw new Error(
        `Tool "${tool.name}" has neither .call() nor .invoke() — cannot execute`,
      );
    }
    return fn.call(tool, args);
  }

  /**
   * Wrap a tool so every call is automatically guarded.
   * Returns a proxy object with the same interface as the original tool.
   *
   * @example
   * const guardedTool = guard.wrap(myTool);
   * const result = await guardedTool.call(args);
   */
  wrap<TArgs extends Record<string, unknown>, TReturn>(
    tool: AgentTool<TArgs, TReturn>,
    ctx: AgentCallContext = {},
  ): AgentTool<TArgs, TReturn> & { call(args: TArgs): Promise<TReturn> } {
    const self = this;
    return {
      ...tool,
      call: (args: TArgs) => self.call(tool, args, ctx),
      invoke: (args: TArgs) => self.call(tool, args, ctx),
    };
  }

  /**
   * Wrap every tool in an array. Convenience for guarding an entire toolkit.
   *
   * @example
   * const tools = guard.wrapAll([searchTool, codeTool], { agentId: 'planner' });
   */
  wrapAll<TArgs extends Record<string, unknown>, TReturn>(
    tools: AgentTool<TArgs, TReturn>[],
    ctx: AgentCallContext = {},
  ): Array<AgentTool<TArgs, TReturn> & { call(args: TArgs): Promise<TReturn> }> {
    return tools.map((t) => this.wrap(t, ctx));
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export interface AgentGuardFactory {
  /**
   * Evaluate and execute a tool call in one step.
   * Shorthand for `new AgentGuard(config).call(tool, args, ctx)`.
   */
  call<TArgs extends Record<string, unknown>, TReturn>(
    tool: AgentTool<TArgs, TReturn>,
    args: TArgs,
    ctx?: AgentCallContext,
  ): Promise<TReturn>;

  /**
   * Wrap a tool so all calls are guarded automatically.
   */
  wrap<TArgs extends Record<string, unknown>, TReturn>(
    tool: AgentTool<TArgs, TReturn>,
    ctx?: AgentCallContext,
  ): AgentTool<TArgs, TReturn> & { call(args: TArgs): Promise<TReturn> };

  /**
   * Wrap every tool in an array.
   */
  wrapAll<TArgs extends Record<string, unknown>, TReturn>(
    tools: AgentTool<TArgs, TReturn>[],
    ctx?: AgentCallContext,
  ): Array<AgentTool<TArgs, TReturn> & { call(args: TArgs): Promise<TReturn> }>;

  /** The underlying AgentGuard instance. */
  readonly guard: AgentGuard;
}

/**
 * Create an agent guard factory from config. Returns a convenient object that
 * exposes `.call()`, `.wrap()`, and `.wrapAll()` directly so callers don't
 * need to instantiate AgentGuard themselves.
 *
 * @example
 * const guard = agentGuard({ apiKey: process.env.ATLASENT_API_KEY });
 * const result = await guard.call(tool, args, { agentId: 'planner' });
 */
export function agentGuard(config: AgentGuardConfig): AgentGuardFactory {
  const instance = new AgentGuard(config);
  return {
    guard: instance,
    call: (tool, args, ctx) => instance.call(tool, args, ctx),
    wrap: (tool, ctx) => instance.wrap(tool, ctx),
    wrapAll: (tools, ctx) => instance.wrapAll(tools, ctx),
  };
}
