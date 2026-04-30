import { describe, expect, it } from "vitest";
import { parseInputs } from "../inputs";

describe("parseInputs", () => {
  it("parses v2.0 single-input path", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      INPUT_ACTION: "production_deploy",
      GITHUB_ACTOR: "alice",
    });
    expect(out.evaluations).toBeUndefined();
    expect(out.single?.action).toBe("production_deploy");
    expect(out.single?.actor).toBe("alice");
  });

  it("parses v2.1 list-input path", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      INPUT_EVALUATIONS: JSON.stringify([
        { action: "deploy.staging", actor: "alice" },
        { action: "deploy.prod", actor: "alice" },
      ]),
    });
    expect(out.evaluations).toHaveLength(2);
    expect(out.evaluations?.[1].action).toBe("deploy.prod");
  });

  it("prefers list when both are set", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      INPUT_ACTION: "ignored",
      INPUT_EVALUATIONS: JSON.stringify([
        { action: "deploy.prod", actor: "alice" },
      ]),
    });
    expect(out.evaluations).toHaveLength(1);
    expect(out.single).toBeUndefined();
  });

  it("throws on empty list", () => {
    expect(() =>
      parseInputs({
        "INPUT_API-KEY": "ask_test",
        INPUT_EVALUATIONS: "[]",
      }),
    ).toThrow(/non-empty/);
  });

  it("throws a clear error on invalid JSON in evaluations", () => {
    expect(() =>
      parseInputs({
        "INPUT_API-KEY": "ask_test",
        INPUT_EVALUATIONS: "not-json",
      }),
    ).toThrow(/not valid JSON/);
  });

  it("throws a clear error on invalid JSON in context", () => {
    expect(() =>
      parseInputs({
        "INPUT_API-KEY": "ask_test",
        INPUT_ACTION: "deploy",
        INPUT_CONTEXT: "{bad json}",
      }),
    ).toThrow(/not valid JSON/);
  });

  it("throws when neither single nor list is set", () => {
    expect(() => parseInputs({ "INPUT_API-KEY": "ask_test" })).toThrow(
      /Missing required input: action/,
    );
  });
});
