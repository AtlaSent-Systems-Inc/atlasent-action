// Wave B.AC1 — input parser.
//
// The action accepts either:
//   - a single `action` input (v2.0 behavior, preserved exactly), or
//   - a list of evaluations as a JSON `evaluations` input (v2.1).
//
// When both are set, `evaluations` wins and `action` is ignored. This
// is auto-detected so existing workflows continue to work unchanged.

import type { EvaluateRequest } from "./types";

export interface ActionInputs {
  apiKey: string;
  apiUrl: string;
  failOnDeny: boolean;
  /** When provided, fan out via evaluateMany. Otherwise single eval. */
  evaluations?: EvaluateRequest[];
  /** Single-input fallback (v2.0 path). */
  single?: EvaluateRequest;
  /** Optional change_window evaluation id to wait on after dispatch. */
  waitForId?: string;
  waitTimeoutMs?: number;
}

export function parseInputs(env: Record<string, string | undefined>): ActionInputs {
  const apiKey = required(env, "INPUT_API-KEY");
  const apiUrl = env["INPUT_API-URL"] || "https://api.atlasent.io";
  const failOnDeny = (env["INPUT_FAIL-ON-DENY"] || "true") === "true";

  const evaluationsRaw = env["INPUT_EVALUATIONS"];
  if (evaluationsRaw && evaluationsRaw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(evaluationsRaw);
    } catch {
      throw new Error("`evaluations` is not valid JSON — expected a JSON array of evaluation requests");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        "`evaluations` must be a non-empty JSON array of evaluation requests",
      );
    }
    return {
      apiKey,
      apiUrl,
      failOnDeny,
      evaluations: parsed as EvaluateRequest[],
      waitForId: env["INPUT_WAIT-FOR-ID"] || undefined,
      waitTimeoutMs: parseInt(env["INPUT_WAIT-TIMEOUT-MS"] || "600000", 10),
    };
  }

  const action = required(env, "INPUT_ACTION");
  const actor = env["INPUT_ACTOR"] || env["GITHUB_ACTOR"] || "unknown";
  const environment = env["INPUT_ENVIRONMENT"];
  const contextRaw = env["INPUT_CONTEXT"] || "{}";
  let context: Record<string, unknown> = {};
  try {
    context = JSON.parse(contextRaw) as Record<string, unknown>;
  } catch {
    throw new Error("`context` is not valid JSON — expected a JSON object");
  }

  return {
    apiKey,
    apiUrl,
    failOnDeny,
    single: { action, actor, environment, context },
    waitForId: env["INPUT_WAIT-FOR-ID"] || undefined,
    waitTimeoutMs: parseInt(env["INPUT_WAIT-TIMEOUT-MS"] || "600000", 10),
  };
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) {
    throw new Error(`Missing required input: ${key.replace("INPUT_", "").toLowerCase()}`);
  }
  return v;
}
