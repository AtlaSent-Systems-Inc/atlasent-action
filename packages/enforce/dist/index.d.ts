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
    /**
     * SHA-256 digest of the artifact being authorized (canonical input, NOT
     * presentation metadata). Sent to evaluate as the top-level
     * `execution_payload_hash`, which the runtime binds into the permit
     * (`execution_hash_expected`). Re-presented at verify time as `payload_hash`
     * — a permit issued for one artifact then presented for another fails with
     * `PAYLOAD_MISMATCH`. This is what stops a workflow evaluating one artifact
     * and executing a different one.
     */
    executionPayloadHash?: string;
    /**
     * Wire bindings that MUST appear on the verify-permit body, or verification is
     * refused BEFORE the network round-trip (fail-closed). Guarantees the execution
     * boundary re-presents what the permit was issued for — an unbound verify that a
     * cross-item / wrong-environment / substituted permit could satisfy is refused,
     * not sent. Values are the wire keys: "environment" | "target_id" | "payload_hash".
     */
    requiredBindings?: Array<"environment" | "target_id" | "payload_hash">;
}
export interface Decision {
    decision: "allow" | "deny" | "hold" | "escalate";
    evaluationId?: string;
    permitToken?: string;
    proofHash?: string;
    /**
     * The artifact digest the RUNTIME bound into the permit at evaluate time
     * (`execution_hash_expected`, echoed on the evaluate response). When present it
     * is re-presented at verify as `payload_hash` in preference to any caller-supplied
     * digest — so verify checks the ORIGINAL evaluated artifact, not a re-supplied one.
     */
    executionHashExpected?: string;
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
    /** Precise runtime wire code (e.g. PAYLOAD_MISMATCH, PERMIT_EXPIRED). */
    verifyErrorCode?: string;
    /** Fields that diverged between the presented context and the bound permit. */
    mismatchFields?: string[];
}
export type EnforcePhase = "evaluate" | "verify" | "verify-permit" | "execute";
export declare class EnforceError extends Error {
    readonly phase: EnforcePhase;
    readonly decision: Decision | null;
    /** Coarse verify outcome (verified | mismatch | expired | replay_blocked | invalid | …). */
    readonly outcome?: string;
    /** Precise verify wire code, when the failure came from verify-permit. */
    readonly verifyErrorCode?: string;
    readonly mismatchFields?: string[];
    constructor(message: string, phase: EnforcePhase, decision?: Decision | null, details?: {
        outcome?: string;
        verifyErrorCode?: string;
        mismatchFields?: string[];
    });
}
export declare function evaluate(config: EnforceConfig): Promise<Decision>;
export declare function verify(decision: Decision): void;
/**
 * Derive the `requiredBindings` set from the bindings actually provided for a
 * decision/item — "re-present at verify exactly what was bound at evaluate."
 * A binding that is present at evaluate but absent at verify then fails closed
 * (MISSING_BINDING) instead of silently dropping off the wire. Empty strings do
 * not count as present.
 */
export declare function requiredBindingsFor(b: {
    environment?: string;
    targetId?: string;
    executionPayloadHash?: string;
}): Array<"environment" | "target_id" | "payload_hash">;
export declare function verifyPermit(config: EnforceConfig, decision: Decision): Promise<VerifyPermitResult>;
export declare function reverifyPermit(config: EnforceConfig, permitToken: string): Promise<VerifyPermitResult>;
export declare function enforce<T>(config: EnforceConfig, fn: () => Promise<T>): Promise<{
    result: T;
    decision: Decision;
    verifyOutcome?: string;
}>;
