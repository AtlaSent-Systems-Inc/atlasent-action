import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Decision, EvaluateRequest } from "../types";

// Mock the evidence client so we observe what the batch emitter does
// without making real HTTP calls. The factory pattern is required by
// vitest's hoisting — the module is mocked before any imports run.
vi.mock("../evidenceClient", () => ({
  emitEvidenceEvent: vi.fn(async () => {}),
}));

import { emitBatchEvidence } from "../v21";
import { emitEvidenceEvent } from "../evidenceClient";

const cfg = { apiKey: "ask_test_dummy", apiUrl: "https://api.atlasent.test" };

const noopLog = { info: () => {}, warning: () => {} };

const allowVerified = (id: string, token: string): Decision => ({
  id,
  decision: "allow",
  permitToken: token,
  verified: true,
  evaluatedAt: "2026-05-08T00:00:00.000Z",
});

const item = (action: string, env?: string): EvaluateRequest => ({
  action,
  actor: "github:tester",
  environment: env,
  context: { source: "test" },
});

describe("emitBatchEvidence", () => {
  beforeEach(() => {
    vi.mocked(emitEvidenceEvent).mockClear();
    vi.mocked(emitEvidenceEvent).mockImplementation(async () => {});
  });

  // -------------------------------------------------------------------
  // 1. Happy path: each allow+verified produces one emit
  // -------------------------------------------------------------------
  it("emits execution_started for every allow+verified decision", async () => {
    const decisions: Decision[] = [
      allowVerified("eval-1", "permit-1"),
      allowVerified("eval-2", "permit-2"),
    ];
    const items = [item("deployment.production", "live"), item("rotate.key", "test")];

    await emitBatchEvidence(decisions, items, cfg, noopLog);

    expect(emitEvidenceEvent).toHaveBeenCalledTimes(2);

    // Inspect the first call's payload — assert the wire shape contracts.
    const firstCall = vi.mocked(emitEvidenceEvent).mock.calls[0];
    expect(firstCall[0]).toEqual(cfg);
    expect(firstCall[1]).toMatchObject({
      event_type: "execution_started",
      permit_token: "permit-1",
      evaluation_id: "eval-1",
      environment: "live",
    });
    expect((firstCall[1] as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({
        source: "github-action-batch",
        action: "deployment.production",
        actor: "github:tester",
      });
  });

  // -------------------------------------------------------------------
  // 2. Emitter failure is swallowed/logged
  // -------------------------------------------------------------------
  it("swallows emitter failures and never throws", async () => {
    vi.mocked(emitEvidenceEvent).mockImplementationOnce(async () => {
      throw new Error("synthetic network failure");
    });

    const decisions: Decision[] = [allowVerified("eval-1", "permit-1")];
    const items = [item("deployment.production", "live")];

    // Must not reject. If it did, the action would crash at this point and
    // the build outcome would be wrong.
    await expect(emitBatchEvidence(decisions, items, cfg, noopLog)).resolves.toBeUndefined();

    expect(emitEvidenceEvent).toHaveBeenCalledTimes(1);
  });

  it("logs a warning when the emitter throws", async () => {
    vi.mocked(emitEvidenceEvent).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const log = { info: vi.fn(), warning: vi.fn() };
    const decisions: Decision[] = [allowVerified("eval-1", "permit-1")];
    const items = [item("deployment.production", "live")];

    await emitBatchEvidence(decisions, items, cfg, log);

    expect(log.warning).toHaveBeenCalled();
    const warningArg = String(log.warning.mock.calls[0]?.[0] ?? "");
    expect(warningArg).toMatch(/boom/);
  });

  // -------------------------------------------------------------------
  // 3. No emit when enforcement / evaluation didn't authorize
  // -------------------------------------------------------------------
  it("does not emit for deny / hold / escalate decisions", async () => {
    const decisions: Decision[] = [
      { id: "eval-deny",     decision: "deny",     evaluatedAt: "2026-05-08T00:00:00.000Z" },
      { id: "eval-hold",     decision: "hold",     evaluatedAt: "2026-05-08T00:00:00.000Z" },
      { id: "eval-escalate", decision: "escalate", evaluatedAt: "2026-05-08T00:00:00.000Z" },
    ];
    const items = [item("a"), item("b"), item("c")];

    await emitBatchEvidence(decisions, items, cfg, noopLog);

    expect(emitEvidenceEvent).not.toHaveBeenCalled();
  });

  it("does not emit when verified is false", async () => {
    const decisions: Decision[] = [
      { id: "eval-x", decision: "allow", permitToken: "p", verified: false,
        evaluatedAt: "2026-05-08T00:00:00.000Z" },
    ];
    const items = [item("a")];

    await emitBatchEvidence(decisions, items, cfg, noopLog);

    expect(emitEvidenceEvent).not.toHaveBeenCalled();
  });

  it("does not emit when permitToken or id is missing", async () => {
    const decisions: Decision[] = [
      { id: "eval-1", decision: "allow", verified: true,
        evaluatedAt: "2026-05-08T00:00:00.000Z" },                 // no permitToken
      { decision: "allow", permitToken: "p", verified: true,
        evaluatedAt: "2026-05-08T00:00:00.000Z" },                 // no id
    ];
    const items = [item("a"), item("b")];

    await emitBatchEvidence(decisions, items, cfg, noopLog);

    expect(emitEvidenceEvent).not.toHaveBeenCalled();
  });

  it("emits only the authorized subset in a mixed batch", async () => {
    const decisions: Decision[] = [
      allowVerified("eval-ok-1", "permit-1"),
      { id: "eval-deny", decision: "deny",
        evaluatedAt: "2026-05-08T00:00:00.000Z" },
      allowVerified("eval-ok-2", "permit-2"),
    ];
    const items = [item("a"), item("b"), item("c")];

    await emitBatchEvidence(decisions, items, cfg, noopLog);

    expect(emitEvidenceEvent).toHaveBeenCalledTimes(2);
    const ids = vi.mocked(emitEvidenceEvent).mock.calls.map(
      (c) => (c[1] as { evaluation_id: string }).evaluation_id,
    );
    expect(ids.sort()).toEqual(["eval-ok-1", "eval-ok-2"]);
  });
});
