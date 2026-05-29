import { describe, expect, it } from "vitest";
import {
  LEGACY_PRODUCTION_DEPLOY_ALIAS,
  PRODUCTION_DEPLOY_ACTION,
  PROTECTED_ACTIONS_CATALOG,
  assertProtectedAction,
  normalizeProtectedAction,
} from "../canonicalAction";

describe("canonicalAction", () => {
  describe("normalizeProtectedAction", () => {
    it("passes the canonical through unchanged", () => {
      const out = normalizeProtectedAction(PRODUCTION_DEPLOY_ACTION);
      expect(out.canonical).toBe(PRODUCTION_DEPLOY_ACTION);
      expect(out.wasLegacyAlias).toBe(false);
    });

    it("rewrites the legacy alias to the canonical and flags it", () => {
      const out = normalizeProtectedAction(LEGACY_PRODUCTION_DEPLOY_ALIAS);
      expect(out.canonical).toBe(PRODUCTION_DEPLOY_ACTION);
      expect(out.wasLegacyAlias).toBe(true);
    });

    it("leaves unrelated strings unchanged (assert step rejects them separately)", () => {
      const out = normalizeProtectedAction("deploy.staging");
      expect(out.canonical).toBe("deploy.staging");
      expect(out.wasLegacyAlias).toBe(false);
    });
  });

  describe("assertProtectedAction", () => {
    it("accepts the canonical", () => {
      expect(() => assertProtectedAction(PRODUCTION_DEPLOY_ACTION)).not.toThrow();
    });

    it("accepts the legacy alias", () => {
      expect(() => assertProtectedAction(LEGACY_PRODUCTION_DEPLOY_ALIAS)).not.toThrow();
    });

    it("rejects malformed action strings", () => {
      // Uppercase is not a valid format
      expect(() => assertProtectedAction("DEPLOY.STAGING")).toThrow(
        /Invalid action type/,
      );
    });

    it("error message describes format requirements", () => {
      expect(() => assertProtectedAction("BAD_FORMAT")).toThrow(
        /dot-separated lowercase/,
      );
    });

    it("accepts any well-formed action type (format-only validation)", () => {
      // These are valid dot-separated lowercase strings — format passes regardless of catalog
      expect(() => assertProtectedAction("deploy.staging")).not.toThrow();
      expect(() => assertProtectedAction("custom.action.type")).not.toThrow();
    });

    it("accepts representative Phase 4–6 catalog actions", () => {
      // Phase 6 — database
      expect(() => assertProtectedAction("database.migration.apply")).not.toThrow();
      // Phase 4 — HR
      expect(() => assertProtectedAction("hr.employee.offboard")).not.toThrow();
      // Phase 5 — security
      expect(() => assertProtectedAction("security.incident.escalate")).not.toThrow();
      // Phase 5 — access
      expect(() => assertProtectedAction("access.cert.revoke")).not.toThrow();
    });

    it("PROTECTED_ACTIONS_CATALOG contains exactly 19 entries", () => {
      expect(PROTECTED_ACTIONS_CATALOG.size).toBe(19);
    });
  });
});
