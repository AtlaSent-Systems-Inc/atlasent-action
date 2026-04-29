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
export type EnforcePhase = "evaluate" | "verify" | "execute";
export declare class EnforceError extends Error {
    readonly phase: EnforcePhase;
    readonly decision: Decision | null;
    constructor(message: string, phase: EnforcePhase, decision?: Decision | null);
}
export declare function evaluate(config: EnforceConfig): Promise<Decision>;
export declare function verify(decision: Decision): void;
export declare function enforce<T>(config: EnforceConfig, fn: () => Promise<T>): Promise<{
    result: T;
    decision: Decision;
}>;
