import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock @atlasent/enforce before importing index so that enforce() is
// intercepted. EnforceError must still be the real class so instanceof checks
// in run() work correctly.
vi.mock("../evidenceClient", () => ({ emitEvidenceEvent: vi.fn(async () => {}) }));

vi.mock("@atlasent/enforce", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlasent/enforce")>();
  return {
    ...original,
    enforce: vi.fn(),
    evaluate: vi.fn(),
    verifyPermit: vi.fn(),
    reverifyPermit: vi.fn(),
    waitForApprovalResolution: vi.fn(),
  };
});

// Mocked so tests can inject controlled PR-review evidence without a real
// GitHub API call. Defaults (set in beforeEach below) match what the real
// resolveApprovals() returns with no GITHUB_TOKEN in the test env: no
// evidence, source "none" — i.e. every pre-existing test's behavior is
// unchanged unless it explicitly overrides the mock.
vi.mock("../approvals", () => ({ resolveApprovals: vi.fn() }));

vi.mock("../workloadIdentity", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workloadIdentity")>();
  return {
    ...original,
    mintGithubActionsActorIdentity: vi.fn(),
  };
});

import {
  enforce,
  evaluate,
  reverifyPermit,
  verifyPermit,
  waitForApprovalResolution,
  EnforceError,
} from "@atlasent/enforce";
import type { Decision } from "@atlasent/enforce";
import { resolveApprovals } from "../approvals";
import { mintGithubActionsActorIdentity } from "../workloadIdentity";

// Import run() after mocking to ensure the mock is in place.
import { run } from "../index";

const mockEnforce = enforce as unknown as ReturnType<typeof vi.fn>;
const mockEvaluate = evaluate as unknown as ReturnType<typeof vi.fn>;
const mockVerifyPermit = verifyPermit as unknown as ReturnType<typeof vi.fn>;
const mockReverifyPermit = reverifyPermit as unknown as ReturnType<typeof vi.fn>;
const mockWaitForApproval = waitForApprovalResolution as unknown as ReturnType<typeof vi.fn>;
const mockResolveApprovals = resolveApprovals as unknown as ReturnType<typeof vi.fn>;
const mockMintWorkloadIdentity = mintGithubActionsActorIdentity as unknown as ReturnType<
  typeof vi.fn
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    decision: "allow",
    evaluationId: "ev-test-1",
    permitToken: "pt-test",
    proofHash: "ph-test",
    riskScore: 10,
    ...overrides,
  };
}

function makeAllowResult(decisionOverrides: Partial<Decision> = {}) {
  return {
    result: undefined,
    decision: makeDecision(decisionOverrides),
    verifyOutcome: "ok",
  };
}

/** Reads the GITHUB_OUTPUT file and returns a map of name→value pairs. */
function readOutputs(outputFile: string): Record<string, string> {
  if (!fs.existsSync(outputFile)) return {};
  const lines = fs.readFileSync(outputFile, "utf-8").split("\n").filter(Boolean);
  const result: Record<string, string> = {};
  for (const line of lines) {
    const eqIdx = line.indexOf("=");
    if (eqIdx !== -1) {
      result[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

// Sentinel error thrown by mocked process.exit so run() is interrupted.
class ProcessExitError extends Error {
  constructor(public readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitError";
  }
}

let outputFile: string;
let exitSpy: { mock: { calls: Array<Array<unknown>> }; mockClear: () => void };
let consoleSpy: { mock: { calls: Array<Array<unknown>> }; mockClear: () => void };
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  // Use a fresh temp file for GITHUB_OUTPUT each test.
  outputFile = path.join(os.tmpdir(), `gha-output-${Date.now()}-${Math.random()}.txt`);
  savedEnv = { ...process.env };

  // Clear action-related env vars.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_") || key === "GITHUB_OUTPUT" || key.startsWith("GITHUB_")) {
      delete process.env[key];
    }
  }

  // Set GITHUB_OUTPUT so setOutput() writes to our temp file.
  process.env["GITHUB_OUTPUT"] = outputFile;

  // Mock process.exit to throw a sentinel so run() stops without ending the process.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(
    (code?: number | string | null) => { throw new ProcessExitError(code); },
  ) as unknown as typeof exitSpy;

  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as typeof consoleSpy;

  mockEnforce.mockReset();
  mockEvaluate.mockReset();
  mockVerifyPermit.mockReset();
  mockReverifyPermit.mockReset();
  mockWaitForApproval.mockReset();
  mockMintWorkloadIdentity.mockReset();
  mockMintWorkloadIdentity.mockResolvedValue({
    actorId: "github-actions:repo:123:workflow:deploy",
    assertion: {
      version: "actor_identity.v1",
      subject: {
        principal_id: "github-actions:repo:123:workflow:deploy",
        principal_kind: "workload",
      },
      signature: "runtime-signed",
    },
    source: {
      issuer: "https://token.actions.githubusercontent.com",
      repository: "AtlaSent-Systems-Inc/app",
      repository_id: "123",
      ref: "refs/heads/main",
      sha: "abc123",
      workflow_ref: "AtlaSent-Systems-Inc/app/.github/workflows/deploy.yml@refs/heads/main",
      actor: "tester",
      actor_id: "42",
      run_id: "100",
      run_attempt: "1",
      environment: "production",
    },
  });

  // Default: no PR-review evidence (mirrors the real resolveApprovals()
  // behavior with no GITHUB_TOKEN set, which every pre-existing test in this
  // file relies on implicitly). Individual tests override with
  // mockResolvedValueOnce to inject controlled evidence.
  mockResolveApprovals.mockReset();
  mockResolveApprovals.mockResolvedValue({
    approvals: 0,
    approving_reviewers: [],
    pr_number: null,
    source: "none",
  });
});

afterEach(() => {
  // Restore env.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);

  // Clean up temp file.
  try { fs.unlinkSync(outputFile); } catch { /* ignore */ }

  vi.restoreAllMocks();
});

function setInput(name: string, value: string) {
  process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
}

function setApiKey(value = "ask_test_key") {
  process.env["ATLASENT_API_KEY"] = value;
}

function getConsoleLogs(): string[] {
  return (consoleSpy as unknown as { mock: { calls: Array<Array<unknown>> } })
    .mock.calls.map((c) => String(c[0]));
}

function getExitCalls(): Array<number | string | null | undefined> {
  return (exitSpy as unknown as { mock: { calls: Array<Array<unknown>> } })
    .mock.calls.map((c) => c[0] as number | string | null | undefined);
}

// ---------------------------------------------------------------------------
// 1. Missing required inputs
// ---------------------------------------------------------------------------

describe("missing required inputs", () => {
  it("calls process.exit(1) when ATLASENT_API_KEY is missing", async () => {
    setInput("action", "production.deploy");
    // ATLASENT_API_KEY is NOT set

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
    expect(getConsoleLogs().some((l) => l.includes("ATLASENT_API_KEY is required"))).toBe(true);
  });

  it("calls process.exit(1) when action is missing on the single-eval path", async () => {
    setApiKey();
    // action is NOT set, evaluations also not set

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
    expect(getConsoleLogs().some((l) => l.includes("Input required and not supplied: action"))).toBe(true);
  });

  it("fails closed when action is not production.deploy", async () => {
    setApiKey();
    setInput("action", "deploy.staging");

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
    expect(mockEnforce).not.toHaveBeenCalled();
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("error");
    expect(outputs["verified"]).toBe("false");
    expect(getConsoleLogs().some((l) => l.includes("production.deploy"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Allow decision → setOutput('decision', 'allow')
// ---------------------------------------------------------------------------

describe("allow response", () => {
  it("sets decision=allow output and does NOT call process.exit", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(getExitCalls()).toHaveLength(0);
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("allow");
    expect(outputs["verified"]).toBe("true");
  });

  it("accepts the legacy deployment.production alias and forwards the canonical to enforce()", async () => {
    setApiKey();
    setInput("action", "deployment.production");

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(getExitCalls()).toHaveLength(0);
    // The first call's first argument is the EnforceConfig. Its `action`
    // field must be the canonical, not the legacy alias the caller sent.
    const calls = (mockEnforce as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
    expect(calls).toHaveLength(1);
    const enforceConfig = calls[0][0] as { action: string };
    expect(enforceConfig.action).toBe("production.deploy");
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("allow");
    expect(outputs["verified"]).toBe("true");
  });

  it("uses only the broker-minted workload actor and assertion for production.deploy", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("actor", "human-dispatcher");
    setInput("environment", "production");
    setInput("artifact-digest", "sha256:artifact-a");
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(mockMintWorkloadIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "production.deploy",
        environment: "production",
      }),
      expect.objectContaining({ mask: expect.any(Function) }),
    );
    const config = mockEnforce.mock.calls[0][0] as {
      actor: string;
      actorIdentity: Record<string, unknown>;
      changePlan: Record<string, unknown>;
      executionPayloadHash?: string;
      context: Record<string, unknown>;
    };
    expect(config.actor).toBe("github-actions:repo:123:workflow:deploy");
    expect(config.actorIdentity).toMatchObject({ version: "actor_identity.v1" });
    expect(config.changePlan).toEqual({
      operation: "deploy",
      revision: "abc123",
      artifact_ref: "sha256:artifact-a",
    });
    expect(config.executionPayloadHash).toBeUndefined();
    expect(config.context["triggering_actor"]).toBe("github:tester");
  });

  it("fails closed before evaluate when workload identity cannot be established", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    mockMintWorkloadIdentity.mockRejectedValueOnce(new Error("wrong repository binding"));

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);

    expect(mockEnforce).not.toHaveBeenCalled();
    expect(readOutputs(outputFile)).toMatchObject({
      decision: "deny",
      verified: "false",
      "verify-error-code": "ACTOR_UNVERIFIED",
    });
    expect(getConsoleLogs().some((line) => line.includes("wrong repository binding"))).toBe(true);
  });

  it("keeps the existing human actor path for actions that do not require workload OIDC", async () => {
    setApiKey();
    setInput("action", "package.release");
    setInput("actor", "release-manager");
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(mockMintWorkloadIdentity).not.toHaveBeenCalled();
    const config = mockEnforce.mock.calls[0][0] as { actor: string; actorIdentity?: unknown };
    expect(config.actor).toBe("github:release-manager");
    expect(config.actorIdentity).toBeUndefined();
  });

  it("sets permit-token, evaluation-id, proof-hash, risk-score outputs on allow", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    mockEnforce.mockResolvedValueOnce(makeAllowResult({
      evaluationId: "ev-abc",
      permitToken: "pt-xyz",
      proofHash: "ph-xyz",
      riskScore: 42,
    }));

    await run();

    const outputs = readOutputs(outputFile);
    expect(outputs["evaluation-id"]).toBe("ev-abc");
    expect(outputs["proof-hash"]).toBe("ph-xyz");
    expect(outputs["risk-score"]).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// 3. Deny decision → process.exit(1) (setFailed)
// ---------------------------------------------------------------------------

describe("deny decision", () => {
  it("calls process.exit(1) when enforce throws EnforceError with deny decision", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    const denyDecision = makeDecision({ decision: "deny", denyReason: "policy violation" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Denied: policy violation", "verify", denyDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
    expect(getConsoleLogs().some((l) => l.includes("policy violation"))).toBe(true);
  });

  it("sets decision=deny output before failing", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    const denyDecision = makeDecision({ decision: "deny", denyReason: "not allowed" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Denied: not allowed", "verify", denyDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);

    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("deny");
    expect(outputs["verified"]).toBe("false");
  });

  it("still fails closed when fail-on-deny=false and decision is deny", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("fail-on-deny", "false");

    const denyDecision = makeDecision({ decision: "deny", denyReason: "informational only" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Denied: informational only", "verify", denyDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// 3b. Pause-and-resume approval protocol (wait-for-approval)
// ---------------------------------------------------------------------------

describe("pause-and-resume approval protocol (wait-for-approval)", () => {
  it("wait-for-approval NOT set: hold with an approval_request_id still fails closed immediately, same as before (opt-in default preserved)", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    const holdDecision = makeDecision({
      decision: "hold",
      holdReason: "awaiting approval",
      approvalRequestId: "apr-1",
    });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("On hold: awaiting approval", "verify", holdDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(mockWaitForApproval).not.toHaveBeenCalled();
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("hold");
  });

  it("wait-for-approval=true, hold with no approval_request_id: cannot wait for something unidentifiable, fails closed immediately", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("wait-for-approval", "true");

    const holdDecision = makeDecision({ decision: "hold", holdReason: "awaiting approval" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("On hold: awaiting approval", "verify", holdDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(mockWaitForApproval).not.toHaveBeenCalled();
  });

  it("wait-for-approval=true: approved with a fresh verified permit → allow, verified=true, no process.exit", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("wait-for-approval", "true");
    setInput("max-wait-minutes", "15");

    const escalateDecision = makeDecision({
      decision: "escalate",
      approvalRequestId: "apr-2",
      permitToken: undefined,
    });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Escalated — manual review required", "verify", escalateDecision),
    );
    mockWaitForApproval.mockResolvedValueOnce({
      status: "approved",
      reEvaluationDecision: "allow",
      permitToken: "pt.v4.fresh",
    });
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "verified" });

    let threw = false;
    try {
      await run();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    expect(mockWaitForApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "apr-2", maxWaitMs: 15 * 60_000 }),
    );
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("allow");
    expect(outputs["verified"]).toBe("true");
  });

  it("wait-for-approval=true: approval resolved to denied → fails closed with the real reason, not the stale hold/escalate one", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("wait-for-approval", "true");

    const holdDecision = makeDecision({
      decision: "hold",
      holdReason: "awaiting approval",
      approvalRequestId: "apr-3",
    });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("On hold: awaiting approval", "verify", holdDecision),
    );
    mockWaitForApproval.mockResolvedValueOnce({ status: "denied" });

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(mockVerifyPermit).not.toHaveBeenCalled();
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("deny");
    expect(getConsoleLogs().some((l) => l.includes("denied"))).toBe(true);
  });

  it("wait-for-approval=true: approved with NO permit token (e.g. re-evaluation held again) fails closed rather than treating approved as allow", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("wait-for-approval", "true");

    const holdDecision = makeDecision({
      decision: "hold",
      approvalRequestId: "apr-4",
    });
    mockEnforce.mockRejectedValueOnce(new EnforceError("On hold", "verify", holdDecision));
    mockWaitForApproval.mockResolvedValueOnce({ status: "approved", reEvaluationDecision: "hold" });

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(mockVerifyPermit).not.toHaveBeenCalled();
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("deny");
  });

  it("wait-for-approval=true: approved with a fresh token that FAILS verification still fails closed", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("wait-for-approval", "true");

    const holdDecision = makeDecision({ decision: "hold", approvalRequestId: "apr-5" });
    mockEnforce.mockRejectedValueOnce(new EnforceError("On hold", "verify", holdDecision));
    mockWaitForApproval.mockResolvedValueOnce({ status: "approved", permitToken: "pt.v4.stale" });
    mockVerifyPermit.mockResolvedValueOnce({ verified: false, outcome: "payload_mismatch" });

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    const outputs = readOutputs(outputFile);
    expect(outputs["verified"]).toBe("false");
  });

  it("wait-for-approval=true: the wait itself timing out fails closed with the timeout message", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("wait-for-approval", "true");

    const holdDecision = makeDecision({ decision: "hold", approvalRequestId: "apr-6" });
    mockEnforce.mockRejectedValueOnce(new EnforceError("On hold", "verify", holdDecision));
    mockWaitForApproval.mockRejectedValueOnce(
      new EnforceError("Approval wait timed out after 1800000ms with no human resolution — failing closed", "evaluate"),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getConsoleLogs().some((l) => l.includes("timed out"))).toBe(true);
  });

  it("wait-for-approval=true has no effect in evaluate-only mode: enforce() is bypassed entirely, so a hold decision falls through evaluate()'s own path, never waitForApprovalResolution", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("mode", "evaluate-only");
    setInput("wait-for-approval", "true");

    // evaluate() (not enforce()) returns hold as a plain Decision — it does
    // not throw for a decision-level hold, only for infra failures. This
    // pins that wait-for-approval never fires outside the enforce() path.
    mockEvaluate.mockResolvedValueOnce(
      makeDecision({ decision: "hold", approvalRequestId: "apr-7", permitToken: undefined }),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(mockWaitForApproval).not.toHaveBeenCalled();
    expect(mockEnforce).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. v1.1 audit fields → setOutput('chain-entry', ...)
// ---------------------------------------------------------------------------

describe("v1.1 audit fields", () => {
  it("sets chain-entry output when API returns chainEntry", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    const chainEntry = { blockHash: "0xabc", txIndex: 1 };
    mockEnforce.mockResolvedValueOnce(makeAllowResult({
      chainEntry,
      snapshot: { state: "captured" },
      auditHash: "audit-hash-xyz",
    }));

    await run();

    const outputs = readOutputs(outputFile);
    expect(outputs["chain-entry"]).toBe(JSON.stringify(chainEntry));
    expect(outputs["snapshot"]).toBe(JSON.stringify({ state: "captured" }));
    expect(outputs["audit-hash"]).toBe("audit-hash-xyz");
  });

  it("sets chain-entry to JSON null when chainEntry is absent", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    mockEnforce.mockResolvedValueOnce(makeAllowResult({ chainEntry: undefined }));

    await run();

    const outputs = readOutputs(outputFile);
    expect(outputs["chain-entry"]).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// 5. Verify failure → process.exit(1) (fail-closed)
// ---------------------------------------------------------------------------

describe("verify failure", () => {
  it("fails closed when permit verification fails", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    const allowDecision = makeDecision({ decision: "allow", permitToken: "pt-replay" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Permit verification failed (outcome=permit_consumed)", "verify-permit", allowDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);

    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("allow");
    expect(outputs["verified"]).toBe("false");
    expect(getConsoleLogs().some((l) => l.includes("Deploy blocked (fail-closed)"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Deprecated ::set-output is NOT emitted
// ---------------------------------------------------------------------------

describe("deprecated ::set-output command", () => {
  it("does not emit ::set-output:: workflow command on allow", async () => {
    setApiKey();
    setInput("action", "production.deploy");

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    const allLogs = getConsoleLogs();
    const deprecated = allLogs.filter((l) => l.includes("::set-output"));
    expect(deprecated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. evaluate-only (issue-permit) mode — B3 two-step execution boundary
// ---------------------------------------------------------------------------

describe("evaluate-only (issue-permit) mode", () => {
  it("issues a permit WITHOUT verifying/consuming: verified=false, permit-issued=true, enforce() not called", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("mode", "evaluate-only");

    mockEvaluate.mockResolvedValueOnce(
      makeDecision({
        permitToken: "pt-unconsumed",
        evaluationId: "ev-eo",
        executionHashExpected: "derived-execution-hash",
      }),
    );

    await run();

    expect(getExitCalls()).toHaveLength(0);
    // For an allow decision, the gate must NOT verify/consume the permit in evaluate-only mode.
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockEvaluate).toHaveBeenCalledTimes(1);

    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("allow");
    expect(outputs["verified"]).toBe("false"); // honest: not verified yet
    expect(outputs["permit-issued"]).toBe("true");
    expect(outputs["permit-token"]).toBe("pt-unconsumed");
    expect(outputs["evaluation-id"]).toBe("ev-eo");
    expect(outputs["execution-hash"]).toBe("derived-execution-hash");
  });

  it("warns the caller to re-verify at the execution boundary", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("mode", "evaluate-only");

    mockEvaluate.mockResolvedValueOnce(makeDecision({ permitToken: "pt-x" }));

    await run();

    const logs = getConsoleLogs();
    expect(
      logs.some((l) => l.includes("::warning::") && l.includes("verify-permit")),
    ).toBe(true);
  });

  it("fails closed when evaluate returns allow but no permit_token", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("mode", "evaluate-only");

    mockEvaluate.mockResolvedValueOnce(makeDecision({ permitToken: undefined }));

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);

    const outputs = readOutputs(outputFile);
    expect(outputs["verified"]).toBe("false");
    expect(outputs["permit-issued"]).toBe("false");
  });

  it("fails closed on deny with the real deny message, not the misleading 'allow without permit' one", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("mode", "evaluate-only");

    mockEvaluate.mockResolvedValueOnce(
      makeDecision({ decision: "deny", denyReason: "policy violation" }),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);

    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("deny");
    expect(outputs["verified"]).toBe("false");
    const logs = getConsoleLogs();
    expect(logs.some((l) => l.includes("policy violation"))).toBe(true);
    expect(logs.some((l) => l.includes("allow without permit"))).toBe(false);
    expect(logs.some((l) => l.includes("allow but no permit_token"))).toBe(false);
  });

  it("fails closed on hold with the real hold message, not the misleading 'allow without permit' one", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("mode", "evaluate-only");

    mockEvaluate.mockResolvedValueOnce(
      makeDecision({ decision: "hold", holdReason: "awaiting change window" }),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);

    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("hold");
    expect(outputs["verified"]).toBe("false");
    const logs = getConsoleLogs();
    expect(logs.some((l) => l.includes("awaiting change window"))).toBe(true);
    expect(logs.some((l) => l.includes("allow without permit"))).toBe(false);
  });

  it("fails closed on escalate with the real escalate message, not the misleading 'allow without permit' one", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("mode", "evaluate-only");

    mockEvaluate.mockResolvedValueOnce(makeDecision({ decision: "escalate" }));

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);

    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("escalate");
    expect(outputs["verified"]).toBe("false");
    const logs = getConsoleLogs();
    expect(logs.some((l) => l.includes("manual review required"))).toBe(true);
    expect(logs.some((l) => l.includes("allow without permit"))).toBe(false);
  });

  it("default mode (enforce) still verifies via enforce() and outputs verified=true", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    // no mode input → defaults to enforce

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(mockEnforce).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).not.toHaveBeenCalled();
    const outputs = readOutputs(outputFile);
    expect(outputs["verified"]).toBe("true");
    expect(outputs["permit-issued"]).toBe("true");
  });
});

describe("verify-only execution boundary", () => {
  it("fails closed when production.deploy omits the runtime-derived execution hash", async () => {
    setApiKey();
    setInput("verify-permit", "true");
    setInput("permit-token", "pt-unconsumed");
    setInput("action", "production.deploy");
    setInput("environment", "production");
    setInput("artifact-digest", "sha256:raw-artifact");

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);

    expect(mockReverifyPermit).not.toHaveBeenCalled();
    expect(readOutputs(outputFile)).toMatchObject({
      decision: "deny",
      verified: "false",
      "verify-error-code": "MISSING_BINDING",
    });
  });

  it("re-verifies production.deploy with the opaque execution-hash output", async () => {
    setApiKey();
    setInput("verify-permit", "true");
    setInput("permit-token", "pt-unconsumed");
    setInput("action", "production.deploy");
    setInput("environment", "production");
    setInput("artifact-digest", "sha256:raw-artifact");
    setInput("execution-hash", "runtime-derived-hash");
    mockReverifyPermit.mockResolvedValueOnce({ verified: true, outcome: "verified" });

    await run();

    const config = mockReverifyPermit.mock.calls[0][0] as {
      executionPayloadHash?: string;
      requiredBindings?: string[];
    };
    expect(config.executionPayloadHash).toBe("runtime-derived-hash");
    expect(config.requiredBindings).toContain("payload_hash");
    expect(readOutputs(outputFile)).toMatchObject({
      decision: "allow",
      verified: "true",
      "verify-outcome": "verified",
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Verified/derived context fields cannot be overridden by operator input
//
// Regression test for a real vulnerability: a prior version spread the
// operator-supplied `context` YAML input LAST when building the EnforceConfig
// context, so a workflow author could write
// `context: '{"approvals": 999, "repository": "evil/repo"}'` and silently
// override the real GitHub-API-derived approval count and the real
// repository/ref/sha/workflow read from the GitHub Actions environment. This
// defeats the entire purpose of deriving those facts. See
// atlasent-keys#<trust-root-gate-hardening> and the comment above the
// `context:` object in index.ts.
// ---------------------------------------------------------------------------

describe("verified/derived context fields resist operator override", () => {
  function setGitHubContext(overrides: Partial<Record<string, string>> = {}) {
    const defaults: Record<string, string> = {
      GITHUB_REPOSITORY: "AtlaSent-Systems-Inc/atlasent-keys",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "abc123real",
      GITHUB_RUN_ID: "999",
      GITHUB_RUN_NUMBER: "1",
      GITHUB_WORKFLOW: "publish-trust-root",
      GITHUB_EVENT_NAME: "push",
      GITHUB_SERVER_URL: "https://github.com",
    };
    for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
      process.env[k] = v;
    }
  }

  it("a real 0-approval PR cannot be overridden by a self-asserted context.approvals", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext();
    // Operator-supplied context claims 999 approvals and a fabricated
    // reviewer list — this must NOT reach the runtime.
    setInput("context", JSON.stringify({ approvals: 999, approving_reviewers: ["nobody"] }));

    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 0,
      approving_reviewers: [],
      pr_number: 1930,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    const calls = (mockEnforce as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
    const enforceConfig = calls[0][0] as { context: Record<string, unknown> };
    expect(enforceConfig.context["approvals"]).toBe(0);
    expect(enforceConfig.context["approving_reviewers"]).toEqual([]);
  });

  it("a genuine approval count from PR reviews passes through unmodified", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext();

    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 2,
      approving_reviewers: ["alice", "bob"],
      pr_number: 42,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    const calls = (mockEnforce as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
    const enforceConfig = calls[0][0] as { context: Record<string, unknown> };
    expect(enforceConfig.context["approvals"]).toBe(2);
    expect(enforceConfig.context["approving_reviewers"]).toEqual(["alice", "bob"]);
  });

  it("repository/ref/sha/workflow read from the real GitHub Actions env cannot be overridden by context", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext({
      GITHUB_REPOSITORY: "AtlaSent-Systems-Inc/atlasent-keys",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "realsha123",
      GITHUB_WORKFLOW: "publish-trust-root",
    });
    setInput(
      "context",
      JSON.stringify({
        repository: "attacker/evil-repo",
        ref: "refs/heads/attacker-branch",
        sha: "fakesha",
        workflow: "totally-different-workflow",
        // A legitimate extra field not derived by the action — must still
        // pass through untouched.
        artifact: "trust-root",
      }),
    );

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    const calls = (mockEnforce as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
    const enforceConfig = calls[0][0] as { context: Record<string, unknown> };
    expect(enforceConfig.context["repository"]).toBe("AtlaSent-Systems-Inc/atlasent-keys");
    expect(enforceConfig.context["ref"]).toBe("refs/heads/main");
    expect(enforceConfig.context["sha"]).toBe("realsha123");
    expect(enforceConfig.context["workflow"]).toBe("publish-trust-root");
    // Non-colliding operator-supplied fields still flow through.
    expect(enforceConfig.context["artifact"]).toBe("trust-root");
  });

  it("approvals-from: none still honors an explicit operator-supplied approvals (intentional opt-out)", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("approvals-from", "none");
    setGitHubContext();
    setInput("context", JSON.stringify({ approvals: 2 }));

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    // resolveApprovals must not even be consulted in "none" mode.
    expect(mockResolveApprovals).not.toHaveBeenCalled();
    const calls = (mockEnforce as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
    const enforceConfig = calls[0][0] as { context: Record<string, unknown> };
    expect(enforceConfig.context["approvals"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8. GitHub-approval-artifact minting wiring (atlasent-api#2830)
//
// @atlasent/enforce is mocked at the module level (see the top of this
// file), so evaluate()'s own retry logic (tested directly and thoroughly in
// packages/enforce/src/__tests__/evaluate.test.ts) never actually runs here.
// What these tests prove instead is the piece only index.ts owns: does it
// build the `onInsufficientApprovals` callback with the right shape, under
// the right conditions, and does invoking it actually call
// v1-github-approval-mint with the correct body and return a correctly
// bound approval_quorum.v1?
// ---------------------------------------------------------------------------

describe("GitHub-approval-artifact minting wiring", () => {
  function setGitHubContext(overrides: Partial<Record<string, string>> = {}) {
    const defaults: Record<string, string> = {
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "abc123real",
      GITHUB_RUN_ID: "999",
      GITHUB_RUN_NUMBER: "1",
      GITHUB_WORKFLOW: "deploy",
      GITHUB_EVENT_NAME: "push",
      GITHUB_SERVER_URL: "https://github.com",
    };
    for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
      process.env[k] = v;
    }
  }

  function getConfig(): Record<string, unknown> {
    const calls = (mockEnforce as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
    return calls[0][0] as Record<string, unknown>;
  }

  const HINT = {
    assertion_type: "approval_artifact.v1",
    bind: { action_hash: "hash-abc", tenant_id: "org-1", environment: "production" },
  };

  let savedFetch: typeof fetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("wires a callback when approvals-from: pr-reviews resolves a PR (the default)", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext();
    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 1,
      approving_reviewers: ["alice"],
      pr_number: 42,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(typeof getConfig()["onInsufficientApprovals"]).toBe("function");
  });

  it("does NOT wire a callback when approvals-from: none", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("approvals-from", "none");
    setGitHubContext();
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(getConfig()["onInsufficientApprovals"]).toBeUndefined();
  });

  it("does NOT wire a callback when approval-artifact-mint: false", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setInput("approval-artifact-mint", "false");
    setGitHubContext();
    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 1,
      approving_reviewers: ["alice"],
      pr_number: 42,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(getConfig()["onInsufficientApprovals"]).toBeUndefined();
  });

  it("does NOT wire a callback when no PR was resolved (nothing to mint from)", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext();
    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 0,
      approving_reviewers: [],
      pr_number: null,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(getConfig()["onInsufficientApprovals"]).toBeUndefined();
  });

  it("the wired callback calls v1-github-approval-mint with the correct body and returns a bound quorum", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext();
    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 1,
      approving_reviewers: ["alice"],
      pr_number: 42,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/v1-github-approval-mint$/);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["evaluation_id"]).toBe("ev-1");
      expect(body["repository"]).toBe("acme/widgets");
      expect(body["pull_request_number"]).toBe(42);
      expect(body["action_type"]).toBe("production.deploy");
      expect(body["action_hash"]).toBe("hash-abc");
      expect(body["environment"]).toBe("production");
      return new Response(
        JSON.stringify({
          reviewers: ["alice"],
          artifacts: [{ version: "approval_artifact.v1", reviewer: { principal_id: "github:alice" } }],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await run();

    const callback = getConfig()["onInsufficientApprovals"] as (
      hint: typeof HINT,
      evaluationId: string | undefined,
    ) => Promise<Record<string, unknown> | undefined>;
    const quorum = await callback(HINT, "ev-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(quorum).toBeDefined();
    expect(quorum!["version"]).toBe("approval_quorum.v1");
    expect(quorum!["tenant_id"]).toBe("org-1");
    expect(quorum!["action_hash"]).toBe("hash-abc");
    expect((quorum!["approvals"] as unknown[]).length).toBe(1);
  });

  it("the wired callback returns undefined (never throws) when the mint endpoint rejects the call", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext();
    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 1,
      approving_reviewers: ["alice"],
      pr_number: 42,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403 }),
    ) as unknown as typeof fetch;

    await run();

    const callback = getConfig()["onInsufficientApprovals"] as (
      hint: typeof HINT,
      evaluationId: string | undefined,
    ) => Promise<Record<string, unknown> | undefined>;
    await expect(callback(HINT, "ev-1")).resolves.toBeUndefined();
  });

  it("the wired callback declines (never calls fetch) when the deny carried no evaluationId", async () => {
    setApiKey();
    setInput("action", "production.deploy");
    setGitHubContext();
    mockResolveApprovals.mockResolvedValueOnce({
      approvals: 1,
      approving_reviewers: ["alice"],
      pr_number: 42,
      source: "pr-reviews",
    });
    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await run();

    const callback = getConfig()["onInsufficientApprovals"] as (
      hint: typeof HINT,
      evaluationId: string | undefined,
    ) => Promise<Record<string, unknown> | undefined>;
    await expect(callback(HINT, undefined)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
