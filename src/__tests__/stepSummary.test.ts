import { describe, it, expect } from "vitest";
import { buildGateStepSummary } from "../stepSummary";

const base = {
  action: "production.deploy",
  actor: "github:alice",
  environment: "live",
  runUrl: "https://github.com/org/repo/actions/runs/123",
};

describe("buildGateStepSummary", () => {
  it("renders an AUTHORIZED panel with the evidence anchors on allow", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "allow",
      targetId: "org/repo",
      verified: true,
      verifyOutcome: "verified",
      evaluationId: "eval_abc123",
      auditHash: "a".repeat(40),
      riskScore: 12,
      riskClass: "low",
      permitIssued: true,
      evidenceReceiptId: "rcpt_1",
    });
    expect(md).toContain("✅ AtlaSent Deploy Gate — AUTHORIZED");
    expect(md).toContain("Authorization **granted**");
    expect(md).toContain("**Evaluation ID:** `eval_abc123`");
    // permit is acknowledged as verified, but the token is never printed.
    expect(md).toContain("**Permit:** issued and **verified** (verified) ✓");
    expect(md).toContain("**Evidence receipt:** `rcpt_1`");
    expect(md).toContain("Risk score | 12 (low)");
    // deep link to the decision replay/evidence view.
    expect(md).toContain(
      "https://console.atlasent.io/decisions/eval_abc123/replay",
    );
    expect(md).toContain("verified offline against the signed audit chain");
  });

  it("never prints the permit token or proof hash", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "allow",
      permitIssued: true,
      evaluationId: "eval_x",
    });
    expect(md).not.toMatch(/permit[_-]?token/i);
    expect(md).not.toContain("proofHash");
  });

  it("renders a DENIED panel with the reason and audit anchor", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "deny",
      reason: "requires 2 approvals; found 0",
      evaluationId: "eval_deny1",
      auditHash: "b".repeat(64),
    });
    expect(md).toContain("🔴 AtlaSent Deploy Gate — DENIED");
    expect(md).toContain("Reason | requires 2 approvals; found 0");
    expect(md).toContain("**Evaluation ID:** `eval_deny1`");
    // audit hash is truncated to 24 chars + ellipsis, never the full value.
    expect(md).toContain(`\`${"b".repeat(24)}…\``);
    expect(md).not.toContain("b".repeat(25));
    expect(md).toContain("which policy rule fired");
  });

  it("includes a deny code when one is supplied", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "deny",
      reason: "human approval required",
      denyCode: "INSUFFICIENT_APPROVALS",
    });
    expect(md).toContain("Deny code | `INSUFFICIENT_APPROVALS`");
  });

  it("renders a How-to-fix section from runtime remediation on deny", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "deny",
      reason: "environment_mismatch",
      denyCode: "ENVIRONMENT_MISMATCH",
      remediation: {
        summary: "Use an API key whose environment matches context.environment.",
        how_to: [
          "A live key must evaluate against a production context.",
          "Use a test key for non-production environments.",
        ],
        docs: "https://example.com/deny-codes.md",
      },
    });
    expect(md).toContain("### How to fix");
    expect(md).toContain(
      "Use an API key whose environment matches context.environment.",
    );
    expect(md).toContain("- A live key must evaluate against a production context.");
    expect(md).toContain("[deny-code reference](https://example.com/deny-codes.md)");
  });

  it("never renders a How-to-fix section on allow", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "allow",
      permitIssued: true,
      remediation: { summary: "should not appear", how_to: ["nope"] },
    });
    expect(md).not.toContain("How to fix");
    expect(md).not.toContain("should not appear");
  });

  it("omits How-to-fix when remediation has no usable content", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "deny",
      reason: "policy",
      remediation: { how_to: [] },
    });
    expect(md).not.toContain("### How to fix");
  });

  it("renders a HOLD panel with the approve-and-rerun next step", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "hold",
      reason: "awaiting approval",
      evaluationId: "eval_hold1",
    });
    expect(md).toContain("🟡 AtlaSent Deploy Gate — ON HOLD");
    expect(md).toContain("authorized reviewer must approve");
    expect(md).toContain("https://console.atlasent.io/approvals");
    expect(md).toContain("re-run this job");
  });

  it("renders a fail-closed panel on infra error and explains the default", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "error",
      reason: "evaluate request timed out",
    });
    expect(md).toContain("⛔ AtlaSent Deploy Gate — BLOCKED (fail-closed)");
    expect(md).toContain("could not confirm authorization");
    expect(md).toContain("fail-closed behavior by design");
    expect(md).toContain("Reason | evaluate request timed out");
  });

  it("omits the decision deep link when there is no evaluation id", () => {
    const md = buildGateStepSummary({ ...base, outcome: "error", reason: "boom" });
    expect(md).not.toContain("/decisions/");
    expect(md).toContain("[View workflow run]");
  });

  it("honors a custom console base url", () => {
    const md = buildGateStepSummary({
      ...base,
      outcome: "deny",
      reason: "nope",
      evaluationId: "e1",
      consoleBaseUrl: "https://acme.example.com/",
    });
    expect(md).toContain("https://acme.example.com/decisions/e1/replay");
    expect(md).not.toContain("example.com//decisions");
  });
});
