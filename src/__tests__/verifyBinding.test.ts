import { describe, expect, it } from "vitest";
import { buildVerifyConfig } from "../verifyBinding";
import type { EvaluateRequest } from "../types";

describe("buildVerifyConfig", () => {
  it("forwards environment (top-level), target_id and execution_payload_hash (context)", () => {
    const item: EvaluateRequest = {
      action: "production.deploy",
      actor: "alice",
      environment: "production",
      context: { target_id: "api-service", execution_payload_hash: "sha256:abc" },
    };
    expect(buildVerifyConfig("k", "https://api.test", item)).toEqual({
      apiKey: "k",
      apiUrl: "https://api.test",
      action: "production.deploy",
      actor: "alice",
      environment: "production",
      targetId: "api-service",
      executionPayloadHash: "sha256:abc",
    });
  });

  it("reads target_id / execution_payload_hash / environment from item top-level too", () => {
    const item = {
      action: "a",
      actor: "u",
      target_id: "svc-top",
      execution_payload_hash: "sha256:top",
      context: {},
    } as unknown as EvaluateRequest;
    const cfg = buildVerifyConfig("k", "u", item);
    expect(cfg.targetId).toBe("svc-top");
    expect(cfg.executionPayloadHash).toBe("sha256:top");
  });

  it("top-level wins over context for the same key", () => {
    const item = {
      action: "a",
      actor: "u",
      environment: "prod-top",
      context: { environment: "prod-ctx", target_id: "t" },
    } as unknown as EvaluateRequest;
    expect(buildVerifyConfig("k", "u", item).environment).toBe("prod-top");
  });

  it("leaves bindings undefined when absent — nothing to re-bind (unbound permit)", () => {
    const item: EvaluateRequest = { action: "a", actor: "u" };
    const cfg = buildVerifyConfig("k", "u", item);
    expect(cfg.environment).toBeUndefined();
    expect(cfg.targetId).toBeUndefined();
    expect(cfg.executionPayloadHash).toBeUndefined();
  });

  it("treats empty-string bindings as absent (no false binding)", () => {
    const item: EvaluateRequest = {
      action: "a",
      actor: "u",
      environment: "",
      context: { target_id: "", execution_payload_hash: "" },
    };
    const cfg = buildVerifyConfig("k", "u", item);
    expect(cfg.environment).toBeUndefined();
    expect(cfg.targetId).toBeUndefined();
    expect(cfg.executionPayloadHash).toBeUndefined();
  });

  it("does NOT silently normalize camelCase wire keys", () => {
    const item = {
      action: "a",
      actor: "u",
      context: { targetId: "camel", executionPayloadHash: "sha256:camel" },
    } as unknown as EvaluateRequest;
    const cfg = buildVerifyConfig("k", "u", item);
    // camelCase variants are not the runtime wire spelling → not bound.
    expect(cfg.targetId).toBeUndefined();
    expect(cfg.executionPayloadHash).toBeUndefined();
  });
});
