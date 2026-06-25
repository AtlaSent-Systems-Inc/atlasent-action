"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentGuard = exports.AgentGuardError = void 0;
exports.agentGuard = agentGuard;
const enforce_1 = require("@atlasent/enforce");
/**
 * Thrown when AtlaSent denies or holds a tool call.
 * Callers should catch this and surface it appropriately in the agent loop.
 */
class AgentGuardError extends Error {
    decision;
    toolName;
    evaluationId;
    constructor(message, decision, toolName, evaluationId) {
        super(message);
        this.name = 'AgentGuardError';
        this.decision = decision;
        this.toolName = toolName;
        this.evaluationId = evaluationId;
    }
}
exports.AgentGuardError = AgentGuardError;
// ---------------------------------------------------------------------------
// AgentGuard class
// ---------------------------------------------------------------------------
class AgentGuard {
    config;
    constructor(config) {
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
    async call(tool, args, ctx = {}) {
        const { config } = this;
        const blockOnHold = config.blockOnHold !== false; // default true
        const actorId = (ctx.agentId ? `agent:${ctx.agentId}` : null) ??
            (ctx.userId ? `user:${ctx.userId}` : null) ??
            config.defaultActorId ??
            'agent:unknown';
        const enforceConfig = {
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
                ...Object.fromEntries(Object.entries(ctx).filter(([k]) => !['agentId', 'sessionId', 'userId'].includes(k))),
            },
        };
        let decision;
        try {
            decision = await (0, enforce_1.evaluate)(enforceConfig);
        }
        catch (err) {
            if (err instanceof enforce_1.EnforceError) {
                throw new AgentGuardError(`AtlaSent infra error evaluating tool "${tool.name}": ${err.message}`, 'error', tool.name);
            }
            throw err;
        }
        // Non-allow decisions.
        if (decision.decision === 'deny') {
            throw new AgentGuardError(`Tool "${tool.name}" denied: ${decision.denyReason ?? 'no reason provided'}`, 'deny', tool.name, decision.evaluationId);
        }
        if (decision.decision === 'escalate') {
            throw new AgentGuardError(`Tool "${tool.name}" escalated — manual review required`, 'escalate', tool.name, decision.evaluationId);
        }
        if (decision.decision === 'hold') {
            if (blockOnHold) {
                throw new AgentGuardError(`Tool "${tool.name}" on hold: ${decision.holdReason ?? 'awaiting approval'}`, 'hold', tool.name, decision.evaluationId);
            }
            // blockOnHold=false: fall through and execute anyway (caller's choice).
        }
        // Allow: run verifyPermit before executing (fail-closed).
        if (decision.decision === 'allow') {
            try {
                (0, enforce_1.verify)(decision);
                await (0, enforce_1.verifyPermit)(enforceConfig, decision);
            }
            catch (err) {
                if (err instanceof enforce_1.EnforceError) {
                    throw new AgentGuardError(`AtlaSent permit verification failed for tool "${tool.name}": ${err.message}`, 'error', tool.name, decision.evaluationId);
                }
                throw err;
            }
        }
        // Execute the tool.
        const fn = tool.call ?? tool.invoke;
        if (!fn) {
            throw new Error(`Tool "${tool.name}" has neither .call() nor .invoke() — cannot execute`);
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
    wrap(tool, ctx = {}) {
        const self = this;
        return {
            ...tool,
            call: (args) => self.call(tool, args, ctx),
            invoke: (args) => self.call(tool, args, ctx),
        };
    }
    /**
     * Wrap every tool in an array. Convenience for guarding an entire toolkit.
     *
     * @example
     * const tools = guard.wrapAll([searchTool, codeTool], { agentId: 'planner' });
     */
    wrapAll(tools, ctx = {}) {
        return tools.map((t) => this.wrap(t, ctx));
    }
}
exports.AgentGuard = AgentGuard;
/**
 * Create an agent guard factory from config. Returns a convenient object that
 * exposes `.call()`, `.wrap()`, and `.wrapAll()` directly so callers don't
 * need to instantiate AgentGuard themselves.
 *
 * @example
 * const guard = agentGuard({ apiKey: process.env.ATLASENT_API_KEY });
 * const result = await guard.call(tool, args, { agentId: 'planner' });
 */
function agentGuard(config) {
    const instance = new AgentGuard(config);
    return {
        guard: instance,
        call: (tool, args, ctx) => instance.call(tool, args, ctx),
        wrap: (tool, ctx) => instance.wrap(tool, ctx),
        wrapAll: (tools, ctx) => instance.wrapAll(tools, ctx),
    };
}
