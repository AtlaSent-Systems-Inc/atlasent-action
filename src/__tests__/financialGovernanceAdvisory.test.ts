import { describe, it, expect } from "vitest";
import {
  assessFinancialGovernance,
} from "../financialGovernanceAdvisory";
import type { FinancialAdvisoryInput } from "../financialGovernanceAdvisory";

const baseInput: FinancialAdvisoryInput = {
  actionType: "payment",
  actionValue: 500,
  currency: "USD",
  actorId: "user-001",
  orgId: "org-abc",
};

describe("assessFinancialGovernance", () => {
  it("returns non_financial for zero value", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: 0 });
    expect(result.riskTier).toBe("non_financial");
    expect(result.riskScore).toBe(0);
    expect(result.evidenceRequired).toBe(false);
    expect(result.signals).toHaveLength(0);
    expect(result.adviceMode).toBe("advisory");
  });

  it("returns non_financial for null value", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: null });
    expect(result.riskTier).toBe("non_financial");
    expect(result.riskScore).toBe(0);
    expect(result.evidenceRequired).toBe(false);
  });

  it("returns non_financial for non-USD currency", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: 5000, currency: "EUR" });
    expect(result.riskTier).toBe("non_financial");
  });

  it("returns low tier for low-value action, no evidenceRequired", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: 500 });
    expect(result.riskTier).toBe("low");
    expect(result.evidenceRequired).toBe(false);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(19);
    expect(result.signals).toHaveLength(0);
  });

  it("returns medium tier for mid-range value", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: 10_000 });
    expect(result.riskTier).toBe("medium");
    expect(result.evidenceRequired).toBe(false);
    expect(result.riskScore).toBeGreaterThanOrEqual(20);
    expect(result.riskScore).toBeLessThanOrEqual(49);
    // No signals for medium tier with non-regulatory action type
    expect(result.signals).toHaveLength(0);
  });

  it("returns high tier for $100K, evidenceRequired true, signals non-empty", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: 100_000 });
    expect(result.riskTier).toBe("high");
    expect(result.evidenceRequired).toBe(true);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.some((s) => s.includes("quorum approval recommended"))).toBe(true);
    expect(result.signals.some((s) => s.includes("Evidence bundle"))).toBe(true);
    expect(result.riskScore).toBeGreaterThanOrEqual(50);
    expect(result.riskScore).toBeLessThanOrEqual(79);
  });

  it("returns critical tier for $2M", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: 2_000_000 });
    expect(result.riskTier).toBe("critical");
    expect(result.evidenceRequired).toBe(true);
    expect(result.riskScore).toBeGreaterThanOrEqual(80);
    expect(result.riskScore).toBeLessThanOrEqual(100);
  });

  it("wire_transfer type adds regulatory signal", () => {
    const result = assessFinancialGovernance({
      ...baseInput,
      actionType: "wire_transfer",
      actionValue: 500,
    });
    // Even low-value wire transfers get the regulatory signal
    expect(result.signals.some((s) => s.includes("regulatory reporting implications"))).toBe(true);
    expect(result.signals.some((s) => s.includes("wire_transfer"))).toBe(true);
  });

  it("trading_execution type adds regulatory signal", () => {
    const result = assessFinancialGovernance({
      ...baseInput,
      actionType: "trading_execution",
      actionValue: 5_000,
    });
    expect(result.signals.some((s) => s.includes("regulatory reporting implications"))).toBe(true);
  });

  it("summary contains key fields", () => {
    const result = assessFinancialGovernance({ ...baseInput, actionValue: 100_000 });
    expect(result.summary).toContain("HIGH");
    expect(result.summary).toContain("USD");
    expect(result.summary).toContain("actor=user-001");
  });
});
