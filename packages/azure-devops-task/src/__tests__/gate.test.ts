import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @atlasent/enforce so tests exercise gate.ts's own control flow
// without any real network call, matching the mocking pattern already used
// throughout this repo's own src/__tests__ (see e.g. notifications.test.ts,
// index.test.ts). EnforceError is kept real (imported via importOriginal)
// since gate.ts checks `instanceof EnforceError` to format messages.
vi.mock("@atlasent/enforce", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlasent/enforce")>();
  return {
    ...original,
    evaluate: vi.fn(),
    verify: original.verify, // real — pure decision-check, no HTTP
    verifyPermit: vi.fn(),
    reverifyPermit: vi.fn(),
    waitForApprovalResolution: vi.fn(),
  };
});

import { evaluate, verifyPermit, reverifyPermit, waitForApprovalResolution, EnforceError } from "@atlasent/enforce";
import type { Decision } from "@atlasent/enforce";
import {
  GateInputError,
  emptyOutputs,
  nullLogger,
  parseInputs,
  resolveEnvironment,
  runGate,
  type RawGateEnv,
  type TaskLogger,
} from "../gate";

const mockEvaluate = evaluate as unknown as ReturnType<typeof vi.fn>;
const mockVerifyPermit = verifyPermit as unknown as ReturnType<typeof vi.fn>;
const mockReverifyPermit = reverifyPermit as unknown as ReturnType<typeof vi.fn>;
const mockWaitForApproval = waitForApprovalResolution as unknown as ReturnType<typeof vi.fn>;

function baseEnv(overrides: Partial<RawGateEnv> = {}): RawGateEnv {
  return {
    apiKey: "ask_test_abc123",
    apiUrl: undefined,
    action: "production.deploy",
    actor: undefined,
    targetId: undefined,
    environment: undefined,
    contextRaw: undefined,
    approvalsFromRaw: undefined,
    waitForApprovalRaw: undefined,
    maxWaitMinutesRaw: undefined,
    modeRaw: undefined,
    verifyPermitRaw: undefined,
    permitTokenRaw: undefined,
    buildRequestedFor: undefined,
    releaseRequestedFor: undefined,
    sourceBranch: undefined,
    ...overrides,
  };
}

function allowDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    decision: "allow",
    evaluationId: "eval-1",
    permitToken: "permit-1",
    proofHash: "proof-1",
    riskScore: 12,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Input parsing / defaulting
// ---------------------------------------------------------------------------

describe("parseInputs", () => {
  it("throws GateInputError when ATLASENT_API_KEY is missing", () => {
    expect(() => parseInputs(baseEnv({ apiKey: undefined }))).toThrow(GateInputError);
    expect(() => parseInputs(baseEnv({ apiKey: "  " }))).toThrow(/ATLASENT_API_KEY/);
  });

  it("throws GateInputError when action is missing", () => {
    expect(() => parseInputs(baseEnv({ action: undefined }))).toThrow(/Missing required input: action/);
  });

  it("defaults actor to 'unknown' when no actor input or predefined variable is set", () => {
    const inputs = parseInputs(baseEnv());
    expect(inputs.actor).toBe("unknown");
  });

  it("falls back to Build.RequestedFor when actor input is absent", () => {
    const inputs = parseInputs(baseEnv({ buildRequestedFor: "jane@example.com" }));
    expect(inputs.actor).toBe("jane@example.com");
  });

  it("falls back to Release.RequestedFor when actor and Build.RequestedFor are both absent", () => {
    const inputs = parseInputs(baseEnv({ releaseRequestedFor: "release-bot" }));
    expect(inputs.actor).toBe("release-bot");
  });

  it("prefers an explicit actor input over both predefined variables", () => {
    const inputs = parseInputs(
      baseEnv({ actor: "explicit-actor", buildRequestedFor: "build-user", releaseRequestedFor: "release-user" }),
    );
    expect(inputs.actor).toBe("explicit-actor");
  });

  it("parses a valid JSON object context", () => {
    const inputs = parseInputs(baseEnv({ contextRaw: '{"service":"api"}' }));
    expect(inputs.context).toEqual({ service: "api" });
  });

  it("defaults context to {} when absent", () => {
    const inputs = parseInputs(baseEnv());
    expect(inputs.context).toEqual({});
  });

  it("throws GateInputError on invalid JSON context", () => {
    expect(() => parseInputs(baseEnv({ contextRaw: "{not json" }))).toThrow(GateInputError);
  });

  it("throws GateInputError when context is a JSON array, not an object", () => {
    expect(() => parseInputs(baseEnv({ contextRaw: "[1,2,3]" }))).toThrow(/must be a JSON object/);
  });

  it("defaults approvalsFrom to 'none'", () => {
    expect(parseInputs(baseEnv()).approvalsFrom).toBe("none");
  });

  it("accepts approvalsFrom: pr-reviews", () => {
    expect(parseInputs(baseEnv({ approvalsFromRaw: "pr-reviews" })).approvalsFrom).toBe("pr-reviews");
  });

  it("treats an unrecognized approvalsFrom value as 'none'", () => {
    expect(parseInputs(baseEnv({ approvalsFromRaw: "something-else" })).approvalsFrom).toBe("none");
  });

  it("defaults waitForApproval to false", () => {
    expect(parseInputs(baseEnv()).waitForApproval).toBe(false);
  });

  it("parses waitForApproval: true case-insensitively", () => {
    expect(parseInputs(baseEnv({ waitForApprovalRaw: "TRUE" })).waitForApproval).toBe(true);
  });

  it("defaults maxWaitMinutes to 30", () => {
    expect(parseInputs(baseEnv()).maxWaitMinutes).toBe(30);
  });

  it("parses a valid maxWaitMinutes", () => {
    expect(parseInputs(baseEnv({ maxWaitMinutesRaw: "5" })).maxWaitMinutes).toBe(5);
  });

  it("falls back to 30 for a non-positive or non-numeric maxWaitMinutes", () => {
    expect(parseInputs(baseEnv({ maxWaitMinutesRaw: "0" })).maxWaitMinutes).toBe(30);
    expect(parseInputs(baseEnv({ maxWaitMinutesRaw: "-5" })).maxWaitMinutes).toBe(30);
    expect(parseInputs(baseEnv({ maxWaitMinutesRaw: "not-a-number" })).maxWaitMinutes).toBe(30);
  });

  it("passes apiUrl through when set, and leaves it undefined otherwise", () => {
    expect(parseInputs(baseEnv({ apiUrl: "https://example.supabase.co/functions/v1" })).apiUrl).toBe(
      "https://example.supabase.co/functions/v1",
    );
    expect(parseInputs(baseEnv()).apiUrl).toBeUndefined();
  });

  it("passes targetId through when set", () => {
    expect(parseInputs(baseEnv({ targetId: "api-service" })).targetId).toBe("api-service");
  });
});

describe("resolveEnvironment", () => {
  it("prefers an explicit value", () => {
    expect(resolveEnvironment("staging", "ask_live_x", "refs/heads/main")).toBe("staging");
  });

  it("infers 'test' from an ask_test_ API key when no explicit value is set", () => {
    expect(resolveEnvironment(undefined, "ask_test_x", "refs/heads/main")).toBe("test");
  });

  it("infers 'live' from an ask_live_ API key when no explicit value is set", () => {
    expect(resolveEnvironment(undefined, "ask_live_x", "refs/heads/feature")).toBe("live");
  });

  it("infers 'live' for main/master branches when the key has no recognized prefix", () => {
    expect(resolveEnvironment(undefined, "custom-key", "refs/heads/main")).toBe("live");
    expect(resolveEnvironment(undefined, "custom-key", "refs/heads/master")).toBe("live");
  });

  it("infers 'test' for any other branch when the key has no recognized prefix", () => {
    expect(resolveEnvironment(undefined, "custom-key", "refs/heads/feature/x")).toBe("test");
    expect(resolveEnvironment(undefined, "custom-key", undefined)).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// runGate — pass path
// ---------------------------------------------------------------------------

describe("runGate — allow + verified", () => {
  it("succeeds and reports verified=true with the decision's fields", async () => {
    mockEvaluate.mockResolvedValue(allowDecision());
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "verified" });

    const inputs = parseInputs(baseEnv());
    const result = await runGate(inputs, nullLogger);

    expect(result.ok).toBe(true);
    expect(result.outputs.decision).toBe("allow");
    expect(result.outputs.verified).toBe("true");
    expect(result.outputs.permitToken).toBe("permit-1");
    expect(result.outputs.proofHash).toBe("proof-1");
    expect(result.outputs.riskScore).toBe("12");
    expect(result.outputs.evaluationId).toBe("eval-1");
    expect(result.outputs.waitedForApproval).toBe("false");
    expect(mockVerifyPermit).toHaveBeenCalledTimes(1);
  });

  it("omits riskScore when the decision carries none", async () => {
    mockEvaluate.mockResolvedValue(allowDecision({ riskScore: undefined }));
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "verified" });

    const result = await runGate(parseInputs(baseEnv()), nullLogger);
    expect(result.outputs.riskScore).toBe("");
  });
});

// ---------------------------------------------------------------------------
// runGate — fail-closed paths
// ---------------------------------------------------------------------------

describe("runGate — fail-closed on deny/hold/escalate", () => {
  it("fails closed on deny, without calling verify-permit", async () => {
    mockEvaluate.mockResolvedValue({ decision: "deny", denyReason: "no policy matched", evaluationId: "eval-2" });

    const result = await runGate(parseInputs(baseEnv()), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Denied: no policy matched/);
    expect(result.outputs.decision).toBe("deny");
    expect(result.outputs.verified).toBe("false");
    expect(mockVerifyPermit).not.toHaveBeenCalled();
  });

  it("fails closed on hold when wait-for-approval is not enabled", async () => {
    mockEvaluate.mockResolvedValue({
      decision: "hold",
      holdReason: "awaiting change window",
      approvalRequestId: "appr-1",
    });

    const result = await runGate(parseInputs(baseEnv({ waitForApprovalRaw: "false" })), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/On hold: awaiting change window/);
    expect(result.outputs.waitedForApproval).toBe("false");
    expect(mockWaitForApproval).not.toHaveBeenCalled();
    expect(mockVerifyPermit).not.toHaveBeenCalled();
  });

  it("fails closed on escalate when wait-for-approval is not enabled", async () => {
    mockEvaluate.mockResolvedValue({ decision: "escalate" });

    const result = await runGate(parseInputs(baseEnv()), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Escalated/);
    expect(result.outputs.decision).toBe("escalate");
  });

  it("falls through to the ordinary hold denial when wait-for-approval is enabled but no approvalRequestId is present", async () => {
    mockEvaluate.mockResolvedValue({ decision: "hold", holdReason: "no approval id" });

    const result = await runGate(
      parseInputs(baseEnv({ waitForApprovalRaw: "true" })),
      nullLogger,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/On hold: no approval id/);
    expect(mockWaitForApproval).not.toHaveBeenCalled();
    expect(result.outputs.waitedForApproval).toBe("false");
  });
});

describe("runGate — fail-closed on network/API errors", () => {
  it("fails closed when evaluate() throws (infra error) — never treated as allow", async () => {
    mockEvaluate.mockRejectedValue(new EnforceError("AtlaSent API unreachable: fetch failed", "evaluate"));

    const result = await runGate(parseInputs(baseEnv()), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/AtlaSent API unreachable/);
    expect(result.outputs).toEqual(emptyOutputs());
    expect(mockVerifyPermit).not.toHaveBeenCalled();
  });

  it("fails closed when verify-permit throws (e.g. replay/mismatch)", async () => {
    mockEvaluate.mockResolvedValue(allowDecision());
    mockVerifyPermit.mockRejectedValue(
      new EnforceError("Permit verification failed (outcome=replay_blocked)", "verify-permit", allowDecision()),
    );

    const result = await runGate(parseInputs(baseEnv()), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/replay_blocked/);
    expect(result.outputs.verified).toBe("false");
    // The decision fields are still surfaced even on a failed verify, for
    // audit/debugging — only `verified` stays false.
    expect(result.outputs.decision).toBe("allow");
  });

  it("fails closed on a non-EnforceError thrown from evaluate()", async () => {
    mockEvaluate.mockRejectedValue(new Error("boom"));

    const result = await runGate(parseInputs(baseEnv()), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/boom/);
    expect(result.outputs.verified).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// runGate — pause-and-resume (wait-for-approval)
// ---------------------------------------------------------------------------

describe("runGate — wait-for-approval", () => {
  it("waits, then succeeds when the resolution is approved with a fresh permit", async () => {
    mockEvaluate.mockResolvedValue({
      decision: "hold",
      holdReason: "awaiting change window",
      approvalRequestId: "appr-1",
      evaluationId: "eval-3",
    });
    mockWaitForApproval.mockResolvedValue({ status: "approved", permitToken: "fresh-permit" });
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "verified" });

    const result = await runGate(
      parseInputs(baseEnv({ waitForApprovalRaw: "true", maxWaitMinutesRaw: "10" })),
      nullLogger,
    );

    expect(result.ok).toBe(true);
    expect(result.outputs.decision).toBe("allow");
    expect(result.outputs.verified).toBe("true");
    expect(result.outputs.waitedForApproval).toBe("true");
    expect(result.outputs.permitToken).toBe("fresh-permit");
    expect(mockWaitForApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-1", maxWaitMs: 10 * 60_000 }),
    );
  });

  it("fails closed when the resolution is denied", async () => {
    mockEvaluate.mockResolvedValue({ decision: "hold", approvalRequestId: "appr-1" });
    mockWaitForApproval.mockResolvedValue({ status: "denied" });

    const result = await runGate(parseInputs(baseEnv({ waitForApprovalRaw: "true" })), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/resolved to 'denied'/);
    expect(result.outputs.decision).toBe("deny");
    expect(result.outputs.waitedForApproval).toBe("true");
    expect(mockVerifyPermit).not.toHaveBeenCalled();
  });

  it("fails closed when approved but no fresh permit token was minted", async () => {
    mockEvaluate.mockResolvedValue({ decision: "escalate", approvalRequestId: "appr-2" });
    mockWaitForApproval.mockResolvedValue({ status: "approved", permitToken: undefined });

    const result = await runGate(parseInputs(baseEnv({ waitForApprovalRaw: "true" })), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.outputs.decision).toBe("deny");
  });

  it("fails closed when waiting itself throws (e.g. timeout)", async () => {
    mockEvaluate.mockResolvedValue({ decision: "hold", approvalRequestId: "appr-1" });
    mockWaitForApproval.mockRejectedValue(
      new EnforceError("Approval wait timed out after 60000ms with no human resolution — failing closed", "evaluate"),
    );

    const result = await runGate(parseInputs(baseEnv({ waitForApprovalRaw: "true" })), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timed out/);
    expect(result.outputs.waitedForApproval).toBe("true");
  });

  it("re-verifies the fresh permit and fails closed if that verification fails", async () => {
    mockEvaluate.mockResolvedValue({ decision: "hold", approvalRequestId: "appr-1" });
    mockWaitForApproval.mockResolvedValue({ status: "approved", permitToken: "fresh-permit" });
    mockVerifyPermit.mockRejectedValue(
      new EnforceError("Permit verification failed (outcome=expired)", "verify-permit"),
    );

    const result = await runGate(parseInputs(baseEnv({ waitForApprovalRaw: "true" })), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/expired/);
    expect(result.outputs.verified).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// approvalsFrom: pr-reviews — v1 has no real ADO PR-review derivation
// ---------------------------------------------------------------------------

describe("runGate — approvalsFrom: pr-reviews (not implemented for ADO in v1)", () => {
  it("warns and still proceeds as approvalsFrom: none", async () => {
    mockEvaluate.mockResolvedValue(allowDecision());
    mockVerifyPermit.mockResolvedValue({ verified: true, outcome: "verified" });

    const warnings: string[] = [];
    const logger: TaskLogger = {
      debug: () => {},
      info: () => {},
      warning: (m) => warnings.push(m),
      error: () => {},
    };

    const result = await runGate(parseInputs(baseEnv({ approvalsFromRaw: "pr-reviews" })), logger);

    expect(result.ok).toBe(true);
    expect(warnings.some((w) => /pr-reviews.*not implemented/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mode: evaluate-only / verifyPermit: true — execution-boundary pattern
// ---------------------------------------------------------------------------

describe("parseInputs — mode / verifyPermit", () => {
  it("defaults mode to 'enforce'", () => {
    expect(parseInputs(baseEnv()).mode).toBe("enforce");
  });

  it("parses mode: evaluate-only", () => {
    expect(parseInputs(baseEnv({ modeRaw: "evaluate-only" })).mode).toBe("evaluate-only");
  });

  it("defaults verifyPermitOnly to false", () => {
    expect(parseInputs(baseEnv()).verifyPermitOnly).toBe(false);
  });

  it("requires permitToken when verifyPermit is true", () => {
    expect(() => parseInputs(baseEnv({ verifyPermitRaw: "true" }))).toThrow(/permitToken/);
  });

  it("accepts verifyPermit: true with a permitToken", () => {
    const inputs = parseInputs(baseEnv({ verifyPermitRaw: "true", permitTokenRaw: "tok-123" }));
    expect(inputs.verifyPermitOnly).toBe(true);
    expect(inputs.permitToken).toBe("tok-123");
  });
});

describe("runGate — mode: evaluate-only", () => {
  it("issues a permit but reports verified=false and never calls verifyPermit", async () => {
    mockEvaluate.mockResolvedValue(allowDecision());

    const result = await runGate(parseInputs(baseEnv({ modeRaw: "evaluate-only" })), nullLogger);

    expect(result.ok).toBe(true);
    expect(result.outputs.decision).toBe("allow");
    expect(result.outputs.verified).toBe("false");
    expect(result.outputs.permitToken).toBe("permit-1");
    expect(mockVerifyPermit).not.toHaveBeenCalled();
  });

  it("still fails closed on deny in evaluate-only mode", async () => {
    mockEvaluate.mockResolvedValue({ decision: "deny", denyReason: "no policy" });

    const result = await runGate(parseInputs(baseEnv({ modeRaw: "evaluate-only" })), nullLogger);

    expect(result.ok).toBe(false);
    expect(result.outputs.verified).toBe("false");
  });

  it("does not enter the wait-for-approval loop even when waitForApproval is true", async () => {
    mockEvaluate.mockResolvedValue({ decision: "hold", approvalRequestId: "appr-1", holdReason: "x" });

    const result = await runGate(
      parseInputs(baseEnv({ modeRaw: "evaluate-only", waitForApprovalRaw: "true" })),
      nullLogger,
    );

    expect(result.ok).toBe(false);
    expect(mockWaitForApproval).not.toHaveBeenCalled();
    expect(result.outputs.waitedForApproval).toBe("false");
  });
});

describe("runGate — verifyPermit: true (execution boundary)", () => {
  it("re-verifies and succeeds without calling evaluate()", async () => {
    mockReverifyPermit.mockResolvedValue({ verified: true, outcome: "verified" });

    const inputs = parseInputs(baseEnv({ verifyPermitRaw: "true", permitTokenRaw: "tok-abc" }));
    const result = await runGate(inputs, nullLogger);

    expect(result.ok).toBe(true);
    expect(result.outputs.decision).toBe("allow");
    expect(result.outputs.verified).toBe("true");
    expect(result.outputs.permitToken).toBe("tok-abc");
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockReverifyPermit).toHaveBeenCalledTimes(1);
  });

  it("fails closed when re-verification fails (e.g. replay or mismatch)", async () => {
    mockReverifyPermit.mockRejectedValue(
      new EnforceError("Permit re-verification failed at execution boundary (outcome=mismatch)", "verify-permit"),
    );

    const inputs = parseInputs(baseEnv({ verifyPermitRaw: "true", permitTokenRaw: "tok-abc" }));
    const result = await runGate(inputs, nullLogger);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/mismatch/);
    expect(result.outputs.decision).toBe("deny");
    expect(result.outputs.verified).toBe("false");
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it("re-presents the same environment/targetId bindings passed to it", async () => {
    mockReverifyPermit.mockResolvedValue({ verified: true, outcome: "verified" });

    const inputs = parseInputs(
      baseEnv({
        verifyPermitRaw: "true",
        permitTokenRaw: "tok-abc",
        environment: "live",
        targetId: "api-service",
      }),
    );
    await runGate(inputs, nullLogger);

    expect(mockReverifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "live",
        targetId: "api-service",
        requiredBindings: expect.arrayContaining(["environment", "target_id"]),
      }),
      "tok-abc",
    );
  });
});
