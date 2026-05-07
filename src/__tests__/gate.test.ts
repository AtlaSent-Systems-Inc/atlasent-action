import { describe, expect, it } from "vitest";
import { GateInfraError } from "../gate";

// The verifyOne() function was removed in favour of the canonical
// verifyPermit() from @atlasent/enforce. Its tests live in
// packages/enforce/src/__tests__/verify-permit.test.ts.

describe("GateInfraError", () => {
  it("is an instance of Error", () => {
    const err = new GateInfraError("something went wrong");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("something went wrong");
    expect(err.name).toBe("GateInfraError");
  });

  it("stores an optional statusCode", () => {
    const err = new GateInfraError("HTTP 500", 500);
    expect(err.statusCode).toBe(500);
  });

  it("statusCode is undefined when not provided", () => {
    const err = new GateInfraError("network error");
    expect(err.statusCode).toBeUndefined();
  });
});
