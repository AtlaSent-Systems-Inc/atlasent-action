import { describe, expect, it } from "vitest";
import { verify, EnforceError } from "../index";
import type { Decision } from "../index";

const allowed: Decision = { decision: "allow" };
const denied: Decision = { decision: "deny", denyReason: "policy violation" };
const held: Decision = { decision: "hold", holdReason: "change window" };
const escalated: Decision = { decision: "escalate" };

describe("verify", () => {
  it("passes through an allow decision without throwing", () => {
    expect(() => verify(allowed)).not.toThrow();
  });

  it("throws EnforceError(verify) on deny with reason", () => {
    const err = getEnforceError(() => verify(denied));
    expect(err.phase).toBe("verify");
    expect(err.message).toContain("policy violation");
    expect(err.decision).toBe(denied);
  });

  it("throws EnforceError(verify) on deny with fallback reason", () => {
    const err = getEnforceError(() => verify({ decision: "deny" }));
    expect(err.message).toContain("no reason provided");
  });

  it("throws EnforceError(verify) on hold with reason", () => {
    const err = getEnforceError(() => verify(held));
    expect(err.phase).toBe("verify");
    expect(err.message).toContain("change window");
  });

  it("throws EnforceError(verify) on hold with fallback reason", () => {
    const err = getEnforceError(() => verify({ decision: "hold" }));
    expect(err.message).toContain("awaiting approval");
  });

  it("throws EnforceError(verify) on escalate", () => {
    const err = getEnforceError(() => verify(escalated));
    expect(err.phase).toBe("verify");
    expect(err.message).toContain("Escalated");
  });

  it("attaches the decision to all non-allow errors", () => {
    for (const d of [denied, held, escalated]) {
      const err = getEnforceError(() => verify(d));
      expect(err.decision).toBe(d);
    }
  });
});

function getEnforceError(fn: () => void): EnforceError {
  try {
    fn();
    throw new Error("Expected EnforceError but nothing was thrown");
  } catch (err) {
    if (err instanceof EnforceError) return err;
    throw err;
  }
}
