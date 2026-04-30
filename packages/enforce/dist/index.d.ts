export interface EnforceConfig {
    apiKey: string;
    apiUrl?: string;
    action: string;
    actor: string;
    environment?: string;
    targetId?: string;
    context?: Record<string, unknown>;
}
export interface Decision {
    decision: "allow" | "deny" | "hold" | "escalate";
    evaluationId?: string;
    permitToken?: string;
    proofHash?: string;
    riskScore?: number;
    denyReason?: string;
    holdReason?: string;
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
