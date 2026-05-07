import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock @atlasent/enforce before importing index so that enforce() is
// intercepted. EnforceError must still be the real class so instanceof checks
// in run() work correctly.
vi.mock("@atlasent/enforce", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlasent/enforce")>();
  return {
    ...original,
    enforce: vi.fn(),
  };
});

import { enforce, EnforceError } from "@atlasent/enforce";
import type { Decision } from "@atlasent/enforce";

// Import run() after mocking to ensure the mock is in place.
import { run } from "../index";

const mockEnforce = enforce as unknown as ReturnType<typeof vi.fn>;

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
  process.env[`INPUT_${name.replace(/-/g, "_").toUpperCase()}`] = value;
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
  it("calls process.exit(1) when api-key is missing", async () => {
    setInput("action", "deploy.prod");
    // api-key is NOT set

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
    expect(getConsoleLogs().some((l) => l.includes("Input required and not supplied: api-key"))).toBe(true);
  });

  it("calls process.exit(1) when action is missing on the single-eval path", async () => {
    setInput("api-key", "ask_test_key");
    // action is NOT set, evaluations also not set

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
    expect(getConsoleLogs().some((l) => l.includes("Input required and not supplied: action"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Allow decision → setOutput('decision', 'allow')
// ---------------------------------------------------------------------------

describe("allow response", () => {
  it("sets decision=allow output and does NOT call process.exit", async () => {
    setInput("api-key", "ask_test_key");
    setInput("action", "production_deploy");

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    expect(getExitCalls()).toHaveLength(0);
    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("allow");
    expect(outputs["verified"]).toBe("true");
  });

  it("sets permit-token, evaluation-id, proof-hash, risk-score outputs on allow", async () => {
    setInput("api-key", "ask_test_key");
    setInput("action", "deploy.prod");

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
    setInput("api-key", "ask_test_key");
    setInput("action", "production_deploy");

    const denyDecision = makeDecision({ decision: "deny", denyReason: "policy violation" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Denied: policy violation", "verify", denyDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);
    expect(getExitCalls()).toContain(1);
    expect(getConsoleLogs().some((l) => l.includes("policy violation"))).toBe(true);
  });

  it("sets decision=deny output before failing", async () => {
    setInput("api-key", "ask_test_key");
    setInput("action", "deploy.prod");

    const denyDecision = makeDecision({ decision: "deny", denyReason: "not allowed" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Denied: not allowed", "verify", denyDecision),
    );

    await expect(run()).rejects.toBeInstanceOf(ProcessExitError);

    const outputs = readOutputs(outputFile);
    expect(outputs["decision"]).toBe("deny");
    expect(outputs["verified"]).toBe("false");
  });

  it("does NOT call process.exit when fail-on-deny=false and decision is deny", async () => {
    setInput("api-key", "ask_test_key");
    setInput("action", "deploy.prod");
    setInput("fail-on-deny", "false");

    const denyDecision = makeDecision({ decision: "deny", denyReason: "informational only" });
    mockEnforce.mockRejectedValueOnce(
      new EnforceError("Denied: informational only", "verify", denyDecision),
    );

    await run();

    expect(getExitCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. v1.1 audit fields → setOutput('chain-entry', ...)
// ---------------------------------------------------------------------------

describe("v1.1 audit fields", () => {
  it("sets chain-entry output when API returns chainEntry", async () => {
    setInput("api-key", "ask_test_key");
    setInput("action", "deploy.prod");

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
    setInput("api-key", "ask_test_key");
    setInput("action", "deploy.prod");

    mockEnforce.mockResolvedValueOnce(makeAllowResult({ chainEntry: undefined }));

    await run();

    const outputs = readOutputs(outputFile);
    expect(outputs["chain-entry"]).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// 5. Deprecated ::set-output is NOT emitted
// ---------------------------------------------------------------------------

describe("deprecated ::set-output command", () => {
  it("does not emit ::set-output:: workflow command on allow", async () => {
    setInput("api-key", "ask_test_key");
    setInput("action", "deploy.prod");

    mockEnforce.mockResolvedValueOnce(makeAllowResult());

    await run();

    const allLogs = getConsoleLogs();
    const deprecated = allLogs.filter((l) => l.includes("::set-output"));
    expect(deprecated).toHaveLength(0);
  });
});
