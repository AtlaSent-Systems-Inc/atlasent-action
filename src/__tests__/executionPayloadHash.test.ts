import { describe, expect, it } from "vitest";
import { normalizeExecutionPayloadHash } from "../executionPayloadHash";

const HEX64 = "a".repeat(64);

describe("normalizeExecutionPayloadHash", () => {
  it("returns undefined unchanged", () => {
    expect(normalizeExecutionPayloadHash(undefined)).toBeUndefined();
  });

  it("returns empty string unchanged", () => {
    expect(normalizeExecutionPayloadHash("")).toBe("");
  });

  it("strips an OCI-form sha256: prefix", () => {
    expect(normalizeExecutionPayloadHash(`sha256:${HEX64}`)).toBe(HEX64);
  });

  it("strips other algo prefixes the same way", () => {
    expect(normalizeExecutionPayloadHash(`sha512:${HEX64}`)).toBe(HEX64);
  });

  it("lowercases mixed-case hex after stripping the prefix", () => {
    const mixed = HEX64.slice(0, 32) + HEX64.slice(32).toUpperCase();
    expect(normalizeExecutionPayloadHash(`sha256:${mixed}`)).toBe(HEX64);
  });

  it("passes through a bare lowercase hex digest unchanged", () => {
    expect(normalizeExecutionPayloadHash(HEX64)).toBe(HEX64);
  });

  it("lowercases a bare mixed-case hex digest with no prefix", () => {
    const mixed = HEX64.slice(0, 32) + HEX64.slice(32).toUpperCase();
    expect(normalizeExecutionPayloadHash(mixed)).toBe(HEX64);
  });

  it("returns an unrecognized shape completely unchanged (too short)", () => {
    expect(normalizeExecutionPayloadHash("sha256:deadbeef")).toBe("sha256:deadbeef");
  });

  it("returns an unrecognized shape completely unchanged (non-hex chars)", () => {
    const bogus = `sha256:${"z".repeat(64)}`;
    expect(normalizeExecutionPayloadHash(bogus)).toBe(bogus);
  });

  it("returns a value with no colon and wrong length unchanged", () => {
    expect(normalizeExecutionPayloadHash("not-a-digest")).toBe("not-a-digest");
  });

  it("handles a value containing multiple colons by splitting on the first", () => {
    // e.g. a registry@digest style reference someone might pass by mistake
    expect(normalizeExecutionPayloadHash(`sha256:${HEX64}:extra`)).toBe(
      `sha256:${HEX64}:extra`,
    );
  });
});
