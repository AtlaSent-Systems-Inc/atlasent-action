import { describe, expect, it } from "vitest";
import { parseInputs } from "../inputs";

describe("parseInputs", () => {
  // ── v2.0 single-eval path ───────────────────────────────────────────────

  it("parses v2.0 single-input path", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      INPUT_ACTION: "production_deploy",
      GITHUB_ACTOR: "alice",
    });
    expect(out.evaluations).toBeUndefined();
    expect(out.policySync).toBeUndefined();
    expect(out.single?.action).toBe("production_deploy");
    expect(out.single?.actor).toBe("alice");
  });

  // ── v2.1 batch path ─────────────────────────────────────────────────

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
    expect(out.policySync).toBeUndefined();
  });

  it("prefers list when both action and evaluations are set", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      INPUT_ACTION: "ignored",
      INPUT_EVALUATIONS: JSON.stringify([{ action: "deploy.prod", actor: "alice" }]),
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

  // ── Policy sync path ─────────────────────────────────────────────────

  it("parses policy sync mode with defaults", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      "INPUT_POLICY-SYNC": "true",
      "INPUT_POLICY-BUNDLE": "policies/bundle.json",
    });
    expect(out.policySync).toBeDefined();
    expect(out.policySync?.bundlePath).toBe("policies/bundle.json");
    expect(out.policySync?.dryRun).toBe(true); // default
    expect(out.policySync?.source).toBeUndefined();
    expect(out.evaluations).toBeUndefined();
    expect(out.single).toBeUndefined();
  });

  it("parses policy-dry-run=false", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      "INPUT_POLICY-SYNC": "true",
      "INPUT_POLICY-BUNDLE": "policies/bundle.json",
      "INPUT_POLICY-DRY-RUN": "false",
    });
    expect(out.policySync?.dryRun).toBe(false);
  });

  it("parses policy-dry-run=true explicitly", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      "INPUT_POLICY-SYNC": "true",
      "INPUT_POLICY-BUNDLE": "policies/bundle.json",
      "INPUT_POLICY-DRY-RUN": "true",
    });
    expect(out.policySync?.dryRun).toBe(true);
  });

  it("parses policy-source", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      "INPUT_POLICY-SYNC": "true",
      "INPUT_POLICY-BUNDLE": "policies/bundle.json",
      "INPUT_POLICY-SOURCE": "ci-pipeline",
    });
    expect(out.policySync?.source).toBe("ci-pipeline");
  });

  it("throws when policy-sync=true but policy-bundle is missing", () => {
    expect(() =>
      parseInputs({
        "INPUT_API-KEY": "ask_test",
        "INPUT_POLICY-SYNC": "true",
      }),
    ).toThrow(/policy-bundle.*required/);
  });

  it("policy-sync=true takes priority over evaluations", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      "INPUT_POLICY-SYNC": "true",
      "INPUT_POLICY-BUNDLE": "policies/bundle.json",
      INPUT_EVALUATIONS: JSON.stringify([{ action: "deploy", actor: "alice" }]),
    });
    expect(out.policySync).toBeDefined();
    expect(out.evaluations).toBeUndefined();
  });

  it("policy-sync=true takes priority over single action", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      "INPUT_POLICY-SYNC": "true",
      "INPUT_POLICY-BUNDLE": "policies/bundle.json",
      INPUT_ACTION: "production_deploy",
    });
    expect(out.policySync).toBeDefined();
    expect(out.single).toBeUndefined();
  });

  it("policy-sync=false falls through to normal routing", () => {
    const out = parseInputs({
      "INPUT_API-KEY": "ask_test",
      "INPUT_POLICY-SYNC": "false",
      INPUT_ACTION: "production_deploy",
      GITHUB_ACTOR: "alice",
    });
    expect(out.policySync).toBeUndefined();
    expect(out.single?.action).toBe("production_deploy");
  });
});
