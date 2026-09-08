import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInsightsEvaluate } from "../insights";
import type { InsightsEvaluateConfig, InsightsEvaluateResult } from "../insights";

const BASE: InsightsEvaluateConfig = {
  apiKey: "ask_test_key",
  apiUrl: "https://api.atlasent.io",
  orgId: "org-abc",
  subjectId: "user-001",
};

function makeLog() {
  return { info: vi.fn(), warning: vi.fn() };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

const RESULT: InsightsEvaluateResult = {
  subjectId: "user-001",
  fired: [{ campaignId: "camp-1", name: "Streak reminder", delivery: { channel: "email" } }],
  skipped: [{ campaignId: "camp-2", name: "Cooldown campaign", reason: "cooldown_active" }],
};

describe("runInsightsEvaluate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the org insights endpoint with the expected body and auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, RESULT));
    vi.stubGlobal("fetch", fetchMock);

    const log = makeLog();
    await runInsightsEvaluate(
      { ...BASE, sessionCount: 7, patternScores: { streak: 0.9 }, events: [{ type: "login" }] },
      log,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.atlasent.io/v1/orgs/org-abc/insights/evaluate");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer ask_test_key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      subjectId: "user-001",
      sessionCount: 7,
      patternScores: { streak: 0.9 },
      events: [{ type: "login" }],
    });
  });

  it("returns the parsed result and logs fired campaign names on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, RESULT)));
    const log = makeLog();

    const result = await runInsightsEvaluate(BASE, log);

    expect(result).toEqual(RESULT);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Streak reminder"),
    );
  });

  it("does not log a fired-campaign line when nothing fired", async () => {
    const noFire: InsightsEvaluateResult = { subjectId: "user-001", fired: [], skipped: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, noFire)));
    const log = makeLog();

    const result = await runInsightsEvaluate(BASE, log);

    expect(result).toEqual(noFire);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("returns null and logs advisory info (not warning) on 403 (feature flag not enabled)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));
    const log = makeLog();

    const result = await runInsightsEvaluate(BASE, log);

    expect(result).toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("feature flag not enabled"));
    expect(log.warning).not.toHaveBeenCalled();
  });

  it("returns null and logs a warning on a non-2xx, non-403 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const log = makeLog();

    const result = await runInsightsEvaluate(BASE, log);

    expect(result).toBeNull();
    expect(log.warning).toHaveBeenCalledWith(expect.stringContaining("500"));
  });

  it("returns null and logs a warning when fetch throws (network error) — never blocks the gate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const log = makeLog();

    const result = await runInsightsEvaluate(BASE, log);

    expect(result).toBeNull();
    expect(log.warning).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("returns null and logs a warning when the response body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
      }),
    );
    const log = makeLog();

    const result = await runInsightsEvaluate(BASE, log);

    expect(result).toBeNull();
    expect(log.warning).toHaveBeenCalled();
  });
});
