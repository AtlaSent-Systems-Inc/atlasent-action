// Canonical Deploy Gate V1 protected action — single source of truth
// at the action's I/O boundary.
//
// Mirrors atlasent-api's `_shared/canonical-action.ts`: we accept the
// legacy alias on input and normalize to the canonical before
// forwarding to the server. The server itself is alias-tolerant per
// atlasent-api PR #662, so this is belt-and-suspenders during the V1
// alias window — both ends rewrite to the same string.

export const PRODUCTION_DEPLOY_ACTION = "production.deploy";
export const LEGACY_PRODUCTION_DEPLOY_ALIAS = "deployment.production";

export interface NormalizedProtectedAction {
  canonical: string;
  wasLegacyAlias: boolean;
}

export function normalizeProtectedAction(raw: string): NormalizedProtectedAction {
  if (raw === LEGACY_PRODUCTION_DEPLOY_ALIAS) {
    return { canonical: PRODUCTION_DEPLOY_ACTION, wasLegacyAlias: true };
  }
  return { canonical: raw, wasLegacyAlias: false };
}

export function assertProtectedAction(raw: string): void {
  const { canonical } = normalizeProtectedAction(raw);
  if (canonical !== PRODUCTION_DEPLOY_ACTION) {
    throw new Error(
      `Unsupported protected action "${raw}". Deploy Gate V1 only permits "${PRODUCTION_DEPLOY_ACTION}" ` +
        `(legacy alias "${LEGACY_PRODUCTION_DEPLOY_ALIAS}" is accepted during the V1 alias window).`,
    );
  }
}
