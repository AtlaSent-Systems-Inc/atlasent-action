// Financial Governance Advisory — non-blocking advisory signals for financial actions.
//
// This module is advisory-only: it never throws, never blocks, and never affects
// enforcement decisions. It emits risk signals and a human-readable summary
// intended for GitHub Actions step summaries and audit logs.

export interface FinancialAdvisoryInput {
  actionType: string;
  actionValue: number | null; // null if not a financial action
  currency: string;
  actorId: string;
  orgId: string;
}

export interface FinancialAdvisoryOutput {
  adviceMode: "advisory";
  riskTier: "low" | "medium" | "high" | "critical" | "non_financial";
  riskScore: number; // 0–100
  evidenceRequired: boolean;
  signals: string[]; // human-readable advisory signals
  summary: string; // one-line summary for step summary
}

// ---------------------------------------------------------------------------
// USD-equivalent currency codes we consider "financial" for risk tiering.
// Anything else is treated as non_financial.
// ---------------------------------------------------------------------------
const USD_EQUIVALENT_CURRENCIES = new Set(["USD", "USDC", "USDT", "DAI"]);

// ---------------------------------------------------------------------------
// Action types that carry regulatory reporting implications.
// ---------------------------------------------------------------------------
const REGULATORY_ACTION_TYPES = new Set(["wire_transfer", "trading_execution"]);

// ---------------------------------------------------------------------------
// Risk tier thresholds (USD-equivalent)
// ---------------------------------------------------------------------------
const TIER_LOW_MAX = 1_000;      // < $1K → low
const TIER_MEDIUM_MAX = 50_000;  // $1K–$50K → medium
const TIER_HIGH_MAX = 1_000_000; // $50K–$1M → high; ≥$1M → critical

function computeRiskScore(value: number, tier: FinancialAdvisoryOutput["riskTier"]): number {
  switch (tier) {
    case "non_financial": return 0;
    case "low":           return Math.min(19, Math.round((value / TIER_LOW_MAX) * 19));
    case "medium":        return Math.min(49, 20 + Math.round(((value - TIER_LOW_MAX) / (TIER_MEDIUM_MAX - TIER_LOW_MAX)) * 29));
    case "high":          return Math.min(79, 50 + Math.round(((value - TIER_MEDIUM_MAX) / (TIER_HIGH_MAX - TIER_MEDIUM_MAX)) * 29));
    case "critical":      return Math.min(100, 80 + Math.round(Math.log10(value / TIER_HIGH_MAX) * 10));
  }
}

// ---------------------------------------------------------------------------
// Main assessment function — always returns a result, never throws.
// ---------------------------------------------------------------------------
export function assessFinancialGovernance(
  input: FinancialAdvisoryInput,
): FinancialAdvisoryOutput {
  const { actionType, actionValue, currency, actorId } = input;

  // Non-financial: null/zero value or unrecognised currency.
  const isUsdEquivalent = USD_EQUIVALENT_CURRENCIES.has(currency.toUpperCase());
  if (!actionValue || actionValue <= 0 || !isUsdEquivalent) {
    return {
      adviceMode: "advisory",
      riskTier: "non_financial",
      riskScore: 0,
      evidenceRequired: false,
      signals: [],
      summary: `Financial governance advisory: no financial action detected (actor=${actorId})`,
    };
  }

  // Determine risk tier.
  let riskTier: FinancialAdvisoryOutput["riskTier"];
  if (actionValue < TIER_LOW_MAX) {
    riskTier = "low";
  } else if (actionValue < TIER_MEDIUM_MAX) {
    riskTier = "medium";
  } else if (actionValue < TIER_HIGH_MAX) {
    riskTier = "high";
  } else {
    riskTier = "critical";
  }

  const evidenceRequired = riskTier === "high" || riskTier === "critical";
  const riskScore = computeRiskScore(actionValue, riskTier);

  // Build advisory signals.
  const signals: string[] = [];

  if (riskTier === "high" || riskTier === "critical") {
    signals.push(
      `High-value financial action ($${actionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}) — quorum approval recommended`,
    );
  }

  if (evidenceRequired) {
    signals.push("Evidence bundle required for audit trail");
  }

  if (REGULATORY_ACTION_TYPES.has(actionType)) {
    signals.push(
      `Action type '${actionType}' has regulatory reporting implications`,
    );
  }

  const summary =
    `Financial governance advisory: ${riskTier.toUpperCase()} risk` +
    ` | $${actionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}` +
    ` | score=${riskScore}` +
    ` | evidenceRequired=${evidenceRequired}` +
    ` | actor=${actorId}`;

  return {
    adviceMode: "advisory",
    riskTier,
    riskScore,
    evidenceRequired,
    signals,
    summary,
  };
}
