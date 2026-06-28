export interface EnforceConfig {
    apiKey: string;
    apiUrl?: string;
    action: string;
    actor: string;
    environment?: string;
    targetId?: string;
    resource?: {
        type: string;
        id?: string;
        attributes?: Record<string, unknown>;
    };
    current_state?: {
        description: string;
        attributes?: Record<string, unknown>;
    };
    proposed_state?: {
        description: string;
        attributes?: Record<string, unknown>;
    };
    execution_binding?: {
        kind: string;
        adapter_version?: string;
        resource_id?: string;
        enforcement_point?: string;
    };
    context?: Record<string, unknown>;
    /** Top-level body field required when the action class has requires_state_snapshot=true.
     *  Must be sent alongside context, not nested inside it. */
    state_snapshot?: {
        source?: string;
        source_kind?: string;
        complete?: boolean;
        run_id?: string;
        payload?: unknown;
    };
}
export interface Decision {
    decision: "allow" | "deny" | "hold" | "escalate";
    evaluationId?: string;
    permitToken?: string;
    proofHash?: string;
    riskScore?: number;
    denyReason?: string;
    /** Machine deny code (e.g. INSUFFICIENT_APPROVALS), present on deny. */
    denyCode?: string;
    /**
     * Additive remediation hint the runtime attaches to common, safe-to-disclose
     * denies — tells the caller how to fix it. Surfaced verbatim; never used for
     * a decision.
     */
    remediation?: {
        summary?: string;
        how_to?: string[];
        docs?: string;
    };
    holdReason?: string;
    /** Resolved risk class from the evaluation (critical / high / medium / low). */
    risk_class?: string;
    /** WHY this was allowed — kind + reference ID (policy, quorum, emergency, etc.). */
    authority_basis?: {
        kind: string;
        reference?: string;
        granted_by?: string;
        rationale?: string;
    };
    /**
     * Present iff decision === "hold". ID of the HITL escalation auto-created by
     * the control plane. Poll GET /v1/hitl/{id} for resolution.
     */
    escalation_id?: string;
    /** v1.1 audit chain fields — present when the API returns them. */
    chainEntry?: Record<string, unknown> | null;
    snapshot?: Record<string, unknown> | null;
    auditHash?: string;
}
export interface VerifyPermitResult {
    verified: boolean;
    outcome?: string;
}
export type EnforcePhase = "evaluate" | "verify" | "verify-permit" | "execute";
export declare class EnforceError extends Error {
    readonly phase: EnforcePhase;
    readonly decision: Decision | null;
    constructor(message: string, phase: EnforcePhase, decision?: Decision | null);
}
export declare function evaluate(config: EnforceConfig): Promise<Decision>;
export declare function verify(decision: Decision): void;
export declare function verifyPermit(config: EnforceConfig, decision: Decision): Promise<VerifyPermitResult>;
export declare function enforce<T>(config: EnforceConfig, fn: () => Promise<T>): Promise<{
    result: T;
    decision: Decision;
    verifyOutcome?: string;
}>;
