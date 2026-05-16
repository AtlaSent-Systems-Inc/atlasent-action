import { describe, expect, it } from "vitest";
import {
  LEGACY_PRODUCTION_DEPLOY_ALIAS,
  PRODUCTION_DEPLOY_ACTION,
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

    it("rejects unrelated action strings", () => {
      expect(() => assertProtectedAction("deploy.staging")).toThrow(
        /Deploy Gate V1 only permits "production\.deploy"/,
      );
    });

    it("error message names both the canonical and the legacy alias", () => {
      expect(() => assertProtectedAction("nope")).toThrow(
        new RegExp(
          `${PRODUCTION_DEPLOY_ACTION}.*${LEGACY_PRODUCTION_DEPLOY_ALIAS}`,
          "s",
        ),
      );
    });
  });
});
