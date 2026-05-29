// Canonical action type taxonomy for atlasent-action.
//
// V1 framing: "protected actions"
// V2 framing: authority over a consequential state transition
//
// The action_type is a label on the transition, not the whole story.
// The state transition (current → proposed) is what the evaluator reasons about.
// Policies govern the full action_type namespace — this file does not enumerate
// every allowed value. It provides well-known constants and normalization helpers.
//
// Legacy alias window: LEGACY_PRODUCTION_DEPLOY_ALIAS ("deployment.production")
// is accepted on input and normalized to the canonical "production.deploy".
// Both ends rewrite — see atlasent-api PR #662.

// ---------------------------------------------------------------------------
// Well-known action type constants
// ---------------------------------------------------------------------------

export const PRODUCTION_DEPLOY_ACTION = "production.deploy";
export const DATABASE_MIGRATION_ACTION = "database.migration.apply";
export const DATABASE_SCHEMA_DROP_ACTION = "database.schema.drop";
export const DATA_EXPORT_BULK_ACTION = "data.export.bulk";
export const ADMIN_PERMISSION_GRANT_ACTION = "admin.permission.grant";
export const AGENT_TOOL_CALL_ACTION = "agent.tool.call";
export const SECRET_ROTATION_PRODUCTION_ACTION = "secret.rotation.production";

/** Legacy alias — accepted during the V1 alias window, normalized on input. */
export const LEGACY_PRODUCTION_DEPLOY_ALIAS = "deployment.production";

// ---------------------------------------------------------------------------
// Phase 1–6 catalog (informational — not an enforcement whitelist)
//
// Lists the 19 built-in action types with SDK helpers, governance kits, and
// policy templates. The gate accepts any well-formed action type string;
// this catalog is a reference for tooling and documentation.
// ---------------------------------------------------------------------------

export const PROTECTED_ACTIONS_CATALOG: ReadonlySet<string> = new Set([
  // Phase 1 — Deploy
  "production.deploy",
  // Phase 4 — HR
  "hr.employee.offboard",
  "hr.access.revoke",
  "hr.role.escalate",
  // Phase 4 — Model governance
  "ml.model.promote",
  "ml.model.retire",
  "ml.model.fine_tune",
  // Phase 4 — Data & contracts
  "customer.data.delete",
  "contract.execute",
  "contract.amend",
  // Phase 4 — Pricing
  "pricing.rule.publish",
  "pricing.discount.approve",
  // Phase 5 — Security & access
  "security.incident.escalate",
  "security.access.quarantine",
  "access.cert.revoke",
  // Phase 5 — Finance
  "period.close.certify",
  // Phase 6 — Database
  "database.migration.apply",
  "database.schema.drop",
  "database.table.delete",
]);

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface NormalizedProtectedAction {
  canonical: string;
  wasLegacyAlias: boolean;
}

/**
 * Normalize an action type string, resolving any known legacy aliases.
 * Always returns the canonical form before forwarding to the control plane.
 */
export function normalizeProtectedAction(raw: string): NormalizedProtectedAction {
  if (raw === LEGACY_PRODUCTION_DEPLOY_ALIAS) {
    return { canonical: PRODUCTION_DEPLOY_ACTION, wasLegacyAlias: true };
  }
  return { canonical: raw, wasLegacyAlias: false };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$/;

/**
 * Validate that a string is a well-formed action type.
 * Format: dot-separated lowercase identifiers, 2–4 segments.
 * Does NOT restrict to a fixed whitelist — policies are the authority.
 */
export function isValidActionType(raw: string): boolean {
  return ACTION_TYPE_PATTERN.test(raw);
}

/**
 * Assert that a string is a well-formed action type.
 * Throws if the format is invalid. Does NOT restrict to a fixed whitelist.
 *
 * Previously assertProtectedAction() hard-coded V1 to "production.deploy" only.
 * That constraint now lives in policy, not in this file.
 */
export function assertValidActionType(raw: string): void {
  const { canonical } = normalizeProtectedAction(raw);
  if (!isValidActionType(canonical)) {
    throw new Error(
      `Invalid action type "${raw}". ` +
        `Expected dot-separated lowercase identifiers, 2–4 segments ` +
        `(e.g. "production.deploy", "database.migration.apply").`,
    );
  }
}

/**
 * @deprecated Use assertValidActionType(). Retained for backward compatibility
 * with existing callers during the V1 → V2 transition window.
 */
export function assertProtectedAction(raw: string): void {
  assertValidActionType(raw);
}
