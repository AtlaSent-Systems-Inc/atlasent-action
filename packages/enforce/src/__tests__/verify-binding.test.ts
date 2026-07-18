import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  verifyPermit,
  enforce,
  requiredBindingsFor,
  EnforceError,
} from "../index";
import type { Decision, EnforceConfig } from "../index";

vi.mock("../transport", () => ({ post: vi.fn() }));
import { post } from "../transport";
const mockPost = post as ReturnType<typeof vi.fn>;

const BOUND: EnforceConfig = {
  apiKey: "ask_test_key",
  apiUrl: "https://api.test",
  action: "production.deploy",
  actor: "github:github-actions[bot]",
  environment: "production",
  targetId: "service:api",
  executionPayloadHash: "sha256:artifact-A",
  requiredBindings: ["environment", "target_id", "payload_hash"],
};

function resp(status: number, body: unknown) {
  mockPost.mockResolvedValueOnce({ status, body: JSON.stringify(body) });
}
function lastBody(): Record<string, unknown> {
  const call = mockPost.mock.calls[mockPost.mock.calls.length - 1];
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}
const allow: Decision = { decision: "allow", permitToken: "pt-1" };

describe("verify-permit required-binding enforcement", () => {
  beforeEach(() => mockPost.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("sends every declared binding on the verify body", async () => {
    resp(200, { valid: true, outcome: "verified" });
    await verifyPermit(BOUND, allow);
    const body = lastBody();
    expect(body.environment).toBe("production");
    expect(body.target_id).toBe("service:api");
    expect(body.payload_hash).toBe("sha256:artifact-A");
  });

  // ── missing-binding → fail closed WITHOUT a network round-trip ──────────────
  it("refuses (MISSING_BINDING) and never calls the network when a required binding is absent", async () => {
    const cfg = { ...BOUND, executionPayloadHash: undefined }; // required payload_hash now absent
    const err = await verifyPermit(cfg, allow).catch((e: unknown) => e as EnforceError);
    expect(err).toBeInstanceOf(EnforceError);
    expect(err.phase).toBe("verify-permit");
    expect(err.verifyErrorCode).toBe("MISSING_BINDING");
    expect(err.outcome).toBe("invalid");
    // Fail-closed BEFORE the wire: the unbound verify is never sent.
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("treats an empty-string binding as absent (MISSING_BINDING)", async () => {
    const cfg = { ...BOUND, targetId: "" };
    const err = await verifyPermit(cfg, allow).catch((e: unknown) => e as EnforceError);
    expect(err.verifyErrorCode).toBe("MISSING_BINDING");
    expect(mockPost).not.toHaveBeenCalled();
  });

  // ── the ORIGINAL evaluated hash (server-echoed) wins over caller input ──────
  it("re-presents the runtime-bound execution_hash_expected in preference to caller digest", async () => {
    resp(200, { valid: true, outcome: "verified" });
    await verifyPermit(
      { ...BOUND, executionPayloadHash: "sha256:caller-supplied" },
      { decision: "allow", permitToken: "pt-1", executionHashExpected: "sha256:runtime-bound" },
    );
    expect(lastBody().payload_hash).toBe("sha256:runtime-bound");
  });

  // ── no-execution: a missing required binding stops enforce() before fn runs ─
  it("enforce() never runs the protected fn when a required binding is missing", async () => {
    resp(200, { decision: "allow", permit_token: "pt-1" }); // evaluate → allow
    const fn = vi.fn(async () => "executed");
    const cfg = { ...BOUND, executionPayloadHash: undefined };
    const err = await enforce(cfg, fn).catch((e: unknown) => e as EnforceError);
    expect(err).toBeInstanceOf(EnforceError);
    expect(err.verifyErrorCode).toBe("MISSING_BINDING");
    expect(fn).not.toHaveBeenCalled();
    // one post for evaluate; verify never reached the wire
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  // ── no-execution: a non-valid verify stops enforce() before fn runs ─────────
  it("enforce() never runs the protected fn when verify is not valid (substitution)", async () => {
    resp(200, { decision: "allow", permit_token: "pt-1" }); // evaluate → allow
    resp(200, {
      valid: false,
      outcome: "mismatch",
      verify_error_code: "PAYLOAD_MISMATCH",
      mismatch_fields: ["payload_hash"],
    });
    const fn = vi.fn(async () => "executed");
    const err = await enforce(BOUND, fn).catch((e: unknown) => e as EnforceError);
    expect(err.verifyErrorCode).toBe("PAYLOAD_MISMATCH");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("requiredBindingsFor", () => {
  it("lists exactly the bindings that are present and non-empty", () => {
    expect(
      requiredBindingsFor({
        environment: "production",
        targetId: "service:api",
        executionPayloadHash: "sha256:x",
      }),
    ).toEqual(["environment", "target_id", "payload_hash"]);
  });

  it("omits absent and empty-string bindings", () => {
    expect(requiredBindingsFor({ environment: "production", targetId: "", executionPayloadHash: undefined })).toEqual([
      "environment",
    ]);
    expect(requiredBindingsFor({})).toEqual([]);
  });
});
