// AtlaSent Gate — GitHub Actions job-summary renderer.
//
// WHY THIS EXISTS
// ---------------
// The job summary (GITHUB_STEP_SUMMARY) is the single most prominent surface on
// a GitHub Actions run page — it renders as a rich Markdown panel above the
// logs. Until now the core deploy-gate decision wrote NOTHING there (only the
// optional financial-governance advisory did), so a pilot whose deploy was
// gated had to scroll raw logs to learn what happened, and a denied deploy
// could surface as a bare "Authorization DENIED: no reason provided" with no
// evaluation ID, no audit anchor, and no way to verify the evidence.
//
// This module renders one self-explanatory panel for every terminal gate
// outcome (allow / deny / hold / escalate / fail-closed error) so the customer
// can answer, right on the run page: what was decided, why, and how to trust /
// verify the evidence. It is PURE (returns a string) so it is unit-testable;
// index.ts writes the result to the step summary before failing the step.
//
// Evidence-surfacing rule (matches buildGateDenyComment): show the open
// identifiers — evaluation ID + audit hash (truncated) — and state that the
// permit was issued & verified, but NEVER print the single-use permit token or
// the raw proof hash. The trust signal without leaking the bearer secret.

export type GateOutcome = "allow" | "deny" | "hold" | "escalate" | "error";

export interface GateSummaryInput {
  /** Terminal outcome of the gate. */
  outcome: GateOutcome;
  /** Canonical action type (e.g. production.deploy). */
  action: string;
  /** Display actor (e.g. github:alice). */
  actor: string;
  /** Resolved environment (e.g. live / test). */
  environment: string;
  /** Target resource id, when supplied. */
  targetId?: string;
  /** Link back to this workflow run. */
  runUrl: string;
  /** Human-readable reason for a non-allow outcome, or the error message. */
  reason?: string;
  /** Machine deny code (e.g. INSUFFICIENT_APPROVALS), when surfaced. */
  denyCode?: string;
  /**
   * Additive remediation hint from the runtime for common, safe-to-disclose
   * denies — { summary, how_to[], docs }. Rendered verbatim as "How to fix".
   */
  remediation?: { summary?: string; how_to?: string[]; docs?: string };
  /** allow path: whether the issued permit was verified. */
  verified?: boolean;
  /** allow path: verify outcome string from /v1-verify-permit. */
  verifyOutcome?: string;
  /** Evaluation / decision id — the audit anchor. */
  evaluationId?: string;
  /** Truncated audit chain entry hash. */
  auditHash?: string;
  /** Risk score 0..100, when present. */
  riskScore?: number;
  /** Resolved risk class (critical / high / medium / low), when present. */
  riskClass?: string;
  /** allow path: whether a permit token was issued. */
  permitIssued?: boolean;
  /** allow path: evidence receipt id, when the bundle was built. */
  evidenceReceiptId?: string;
  /** Console base URL for deep links (default https://console.atlasent.io). */
  consoleBaseUrl?: string;
}

const DEFAULT_CONSOLE = "https://console.atlasent.io";

function truncHash(h: string | undefined): string | undefined {
  if (!h) return undefined;
  return h.length > 24 ? `${h.slice(0, 24)}…` : h;
}

/** Build the Markdown job-summary panel for a terminal gate outcome. */
export function buildGateStepSummary(input: GateSummaryInput): string {
  const consoleBase = (input.consoleBaseUrl ?? DEFAULT_CONSOLE).replace(/\/$/, "");
  const isAllow = input.outcome === "allow";

  const icon =
    input.outcome === "allow"
      ? "✅"
      : input.outcome === "deny"
        ? "🔴"
        : input.outcome === "hold"
          ? "🟡"
          : input.outcome === "escalate"
            ? "🚨"
            : "⛔";
  const label =
    input.outcome === "allow"
      ? "AUTHORIZED"
      : input.outcome === "deny"
        ? "DENIED"
        : input.outcome === "hold"
          ? "ON HOLD"
          : input.outcome === "escalate"
            ? "ESCALATED"
            : "BLOCKED (fail-closed)";

  const lines: string[] = [];
  lines.push("", "---", `## ${icon} AtlaSent Deploy Gate — ${label}`, "");

  if (isAllow) {
    lines.push(
      `Authorization **granted** for \`${input.action}\` by **${input.actor}** in **${input.environment}**. ` +
        `The deploy is permitted to proceed.`,
    );
  } else if (input.outcome === "error") {
    lines.push(
      `The gate **could not confirm authorization** for \`${input.action}\`, so the deploy did **not** run. ` +
        `This is fail-closed behavior by design — a gate that cannot verify a decision blocks rather than waves the action through.`,
    );
  } else {
    lines.push(
      `The gate **blocked** \`${input.action}\` by **${input.actor}** in **${input.environment}**. ` +
        `The deploy did not run.`,
    );
  }
  lines.push("");

  // ── Decision table ────────────────────────────────────────────────────────
  lines.push(`| Field | Value |`, `|---|---|`);
  lines.push(`| Decision | \`${input.outcome}\` |`);
  if (!isAllow && input.reason) lines.push(`| Reason | ${input.reason} |`);
  if (!isAllow && input.denyCode) lines.push(`| Deny code | \`${input.denyCode}\` |`);
  lines.push(`| Action | \`${input.action}\` |`);
  lines.push(`| Actor | \`${input.actor}\` |`);
  lines.push(`| Environment | \`${input.environment}\` |`);
  if (input.targetId) lines.push(`| Target | \`${input.targetId}\` |`);
  if (typeof input.riskScore === "number") {
    const cls = input.riskClass ? ` (${input.riskClass})` : "";
    lines.push(`| Risk score | ${input.riskScore}${cls} |`);
  } else if (input.riskClass) {
    lines.push(`| Risk class | \`${input.riskClass}\` |`);
  }
  lines.push("");

  // ── Evidence ──────────────────────────────────────────────────────────────
  const evalId = input.evaluationId;
  const audit = truncHash(input.auditHash);
  const hasEvidence = !!(evalId || audit || (isAllow && input.permitIssued));
  if (hasEvidence) {
    lines.push("### Evidence", "");
    if (evalId) lines.push(`- **Evaluation ID:** \`${evalId}\``);
    if (audit) lines.push(`- **Audit chain hash:** \`${audit}\``);
    if (isAllow && input.permitIssued) {
      const verifiedNote = input.verified
        ? `issued and **verified**${input.verifyOutcome ? ` (${input.verifyOutcome})` : ""}`
        : "issued";
      lines.push(`- **Permit:** ${verifiedNote} ✓`);
    }
    if (isAllow && input.evidenceReceiptId) {
      lines.push(`- **Evidence receipt:** \`${input.evidenceReceiptId}\``);
    }
    lines.push("");
  }

  // ── How to fix (remediation hint from the runtime, deny path only) ────────
  if (!isAllow && input.remediation) {
    const r = input.remediation;
    const steps = (r.how_to ?? []).filter((s) => typeof s === "string" && s.length > 0);
    if (r.summary || steps.length > 0) {
      lines.push("### How to fix", "");
      if (r.summary) lines.push(r.summary, "");
      for (const step of steps) lines.push(`- ${step}`);
      if (r.docs) lines.push("", `See [deny-code reference](${r.docs}).`);
      lines.push("");
    }
  }

  // ── How to verify / next step ─────────────────────────────────────────────
  if (evalId) {
    lines.push(
      `[View the full decision & replay the evidence](${consoleBase}/decisions/${evalId}/replay)`,
    );
  }
  lines.push(`[View workflow run](${input.runUrl})`);

  if (input.outcome === "hold" || input.outcome === "escalate") {
    lines.push(
      "",
      `> **Next step:** an authorized reviewer must approve this deployment in the ` +
        `[AtlaSent console](${consoleBase}/approvals) or via the Slack Approval Bot, ` +
        `then re-run this job.`,
    );
  } else if (input.outcome === "deny") {
    lines.push(
      "",
      `> **Why blocked?** The decision above is recorded as an immutable, hash-linked ` +
        `audit entry. Open the decision link to see exactly which policy rule fired.`,
    );
  } else if (isAllow) {
    lines.push(
      "",
      `> This decision is recorded as a tamper-evident, hash-linked audit entry and ` +
        `can be verified offline against the signed audit chain.`,
    );
  }
  lines.push("");

  return lines.join("\n");
}
