import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runV21 } from "../v21";

// SIM tests for runV21() — the orchestration layer that wires together
// parseInputs + evaluateMany + (optional) waitForTerminalDecision.

vi.mock("../batch", () => ({ evaluateMany: vi.fn() }));
vi.mock("../gate", () => ({ verifyOne: vi.fn() }));
vi.mock("../stream", () => ({ waitForTerminalDecision: vi.fn() }));

import { evaluateMany } from "../batch";
import { verifyOne } from "../gate";
import { waitForTerminalDecision } from "../stream";

const mockEvaluateMany = evaluateMany as ReturnType<typeof vi.fn>;
const mockVerifyOne = verifyOne as ReturnType<typeof vi.fn>;
const mockWait = waitForTerminalDecision as ReturnType<typeof vi.fn>;

// Minimal env that drives the batch path (evaluations set).
const BASE_ENV = {
  "INPUT_API-KEY": "ask_test_key",
  "INPUT_API-URL": "https://api.test",
  "INPUT_FAIL-ON-DENY": "true",
  INPUT_EVALUATIONS: JSON.stringify([{ action: "deploy.prod", actor: "alice" }]),
  "INPUT_WAIT-TIMEOUT-MS": "30000",
};

const FLAGS = { v2Batch: false, v2Streaming: false };

function decision(
  d: "allow" | "deny" | "hold" | "escalate",
  id = "ev-1",
  permitToken?: string,
) {
  return { id, decision: d, evaluatedAt: "2026-04-30T00:00:00Z", permitToken, verified: d === "allow" || undefined };
}

beforeEach(() => {
  mockEvaluateMany.mockReset();
  mockVerifyOne.mockReset();
  mockWait.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Basic routing ─────────────────────────────────────────────────────────────

it("passes items and flags through to evaluateMany", async () => {
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [decision("allow")], batchId: "b1" });
  await runV21(BASE_ENV, { v2Batch: true, v2Streaming: false });
  expect(mockEvaluateMany).toHaveBeenCalledWith(
    "https://api.test",
    "ask_test_key",
    [{ action: "deploy.prod", actor: "alice" }],
    true,
  );
});

it("wraps single action/actor into a 1-item batch", async () => {
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [decision("allow")], batchId: "b1" });
  await runV21(
    { "INPUT_API-KEY": "ask_test_key", INPUT_ACTION: "deploy.staging", INPUT_ACTOR: "bob" },
    FLAGS,
  );
  expect(mockEvaluateMany).toHaveBeenCalledWith(
    "https://api.atlasent.io",
    "ask_test_key",
    [expect.objectContaining({ action: "deploy.staging", actor: "bob" })],
    false,
  );
});

it("returns batchId from evaluateMany", async () => {
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [decision("allow")], batchId: "server-batch-99" });
  const out = await runV21(BASE_ENV, FLAGS);
  expect(out.batchId).toBe("server-batch-99");
});

// ── failed flag ───────────────────────────────────────────────────────────────

it("failed=false when all decisions are allow", async () => {
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [decision("allow")], batchId: "b1" });
  const out = await runV21(BASE_ENV, FLAGS);
  expect(out.failed).toBe(false);
});

it("failed=true when any decision is deny and failOnDeny=true", async () => {
  mockEvaluateMany.mockResolvedValueOnce({
    decisions: [decision("allow"), decision("deny", "ev-2")],
    batchId: "b1",
  });
  const out = await runV21(BASE_ENV, FLAGS);
  expect(out.failed).toBe(true);
});

it("failed=false when deny but failOnDeny=false", async () => {
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [decision("deny")], batchId: "b1" });
  const out = await runV21({ ...BASE_ENV, "INPUT_FAIL-ON-DENY": "false" }, FLAGS);
  expect(out.failed).toBe(false);
});

// ── wait-for-id path ──────────────────────────────────────────────────────────

it("calls waitForTerminalDecision when waitForId matches a hold decision", async () => {
  const hold = decision("hold", "ev-hold");
  const terminal = decision("allow", "ev-hold", "pt-1");
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [hold], batchId: "b1" });
  mockWait.mockResolvedValueOnce(terminal);
  mockVerifyOne.mockResolvedValueOnce({ verified: true, outcome: "ok" });

  const out = await runV21({ ...BASE_ENV, "INPUT_WAIT-FOR-ID": "ev-hold" }, FLAGS);

  expect(mockWait).toHaveBeenCalledOnce();
  expect(mockWait).toHaveBeenCalledWith(
    expect.objectContaining({ evaluationId: "ev-hold", apiKey: "ask_test_key" }),
  );
  expect(mockVerifyOne).toHaveBeenCalledOnce();
  expect(out.decisions[0].decision).toBe("allow");
  expect(out.decisions[0].verified).toBe(true);
});

it("verifies terminal allow from wait-for-id with correct permit params", async () => {
  const hold = decision("hold", "ev-hold");
  const terminal = { ...decision("allow", "ev-hold", "pt-xyz"), verified: undefined };
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [hold], batchId: "b1" });
  mockWait.mockResolvedValueOnce(terminal);
  mockVerifyOne.mockResolvedValueOnce({ verified: true, outcome: "ok" });

  await runV21({ ...BASE_ENV, "INPUT_WAIT-FOR-ID": "ev-hold" }, FLAGS);

  expect(mockVerifyOne).toHaveBeenCalledWith(
    expect.objectContaining({
      permitToken: "pt-xyz",
      actionType: "deploy.prod",
      actorId: "alice",
      verifyPath: "/v1/verify-permit",
    }),
  );
});

it("sets verified=false when terminal allow has no permitToken", async () => {
  const hold = decision("hold", "ev-hold");
  const terminalNoPermit = { id: "ev-hold", decision: "allow" as const, evaluatedAt: "2026-04-30T00:00:00Z" };
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [hold], batchId: "b1" });
  mockWait.mockResolvedValueOnce(terminalNoPermit);

  const out = await runV21({ ...BASE_ENV, "INPUT_WAIT-FOR-ID": "ev-hold" }, FLAGS);

  expect(mockVerifyOne).not.toHaveBeenCalled();
  expect(out.decisions[0].verified).toBe(false);
});

it("calls waitForTerminalDecision when waitForId matches an escalate decision", async () => {
  const escalate = decision("escalate", "ev-esc");
  const terminal = decision("deny", "ev-esc");
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [escalate], batchId: "b1" });
  mockWait.mockResolvedValueOnce(terminal);

  const out = await runV21({ ...BASE_ENV, "INPUT_WAIT-FOR-ID": "ev-esc" }, FLAGS);

  expect(mockWait).toHaveBeenCalledOnce();
  expect(out.decisions[0].decision).toBe("deny");
});

it("skips wait when waitForId does not match any hold/escalate decision", async () => {
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [decision("allow", "ev-other")], batchId: "b1" });

  await runV21({ ...BASE_ENV, "INPUT_WAIT-FOR-ID": "ev-not-found" }, FLAGS);

  expect(mockWait).not.toHaveBeenCalled();
});

it("skips wait when no waitForId is set", async () => {
  mockEvaluateMany.mockResolvedValueOnce({ decisions: [decision("hold")], batchId: "b1" });

  await runV21(BASE_ENV, FLAGS);

  expect(mockWait).not.toHaveBeenCalled();
});
