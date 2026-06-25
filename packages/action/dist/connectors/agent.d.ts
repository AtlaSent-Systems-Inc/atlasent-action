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
export declare class AgentGuardError extends Error {
    readonly decision: 'deny' | 'hold' | 'escalate' | 'error';
    readonly toolName: string;
    readonly evaluationId?: string;
    constructor(message: string, decision: 'deny' | 'hold' | 'escalate' | 'error', toolName: string, evaluationId?: string);
}
export declare class AgentGuard {
    private readonly config;
    constructor(config: AgentGuardConfig);
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
    call<TArgs extends Record<string, unknown>, TReturn>(tool: AgentTool<TArgs, TReturn>, args: TArgs, ctx?: AgentCallContext): Promise<TReturn>;
    /**
     * Wrap a tool so every call is automatically guarded.
     * Returns a proxy object with the same interface as the original tool.
     *
     * @example
     * const guardedTool = guard.wrap(myTool);
     * const result = await guardedTool.call(args);
     */
    wrap<TArgs extends Record<string, unknown>, TReturn>(tool: AgentTool<TArgs, TReturn>, ctx?: AgentCallContext): AgentTool<TArgs, TReturn> & {
        call(args: TArgs): Promise<TReturn>;
    };
    /**
     * Wrap every tool in an array. Convenience for guarding an entire toolkit.
     *
     * @example
     * const tools = guard.wrapAll([searchTool, codeTool], { agentId: 'planner' });
     */
    wrapAll<TArgs extends Record<string, unknown>, TReturn>(tools: AgentTool<TArgs, TReturn>[], ctx?: AgentCallContext): Array<AgentTool<TArgs, TReturn> & {
        call(args: TArgs): Promise<TReturn>;
    }>;
}
export interface AgentGuardFactory {
    /**
     * Evaluate and execute a tool call in one step.
     * Shorthand for `new AgentGuard(config).call(tool, args, ctx)`.
     */
    call<TArgs extends Record<string, unknown>, TReturn>(tool: AgentTool<TArgs, TReturn>, args: TArgs, ctx?: AgentCallContext): Promise<TReturn>;
    /**
     * Wrap a tool so all calls are guarded automatically.
     */
    wrap<TArgs extends Record<string, unknown>, TReturn>(tool: AgentTool<TArgs, TReturn>, ctx?: AgentCallContext): AgentTool<TArgs, TReturn> & {
        call(args: TArgs): Promise<TReturn>;
    };
    /**
     * Wrap every tool in an array.
     */
    wrapAll<TArgs extends Record<string, unknown>, TReturn>(tools: AgentTool<TArgs, TReturn>[], ctx?: AgentCallContext): Array<AgentTool<TArgs, TReturn> & {
        call(args: TArgs): Promise<TReturn>;
    }>;
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
export declare function agentGuard(config: AgentGuardConfig): AgentGuardFactory;
