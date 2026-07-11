import { beforeEach, describe, expect, it, vi } from "vitest";
import { enforce, EnforceError } from "../index";

vi.mock("../transport", () => ({ post: vi.fn() }));

import { post } from "../transport";
const mockPost = post as ReturnType<typeof vi.fn>;

const CONFIG = {
  apiKey: "ask_test_key",
  apiUrl: "https://api.test",
  action: "production.deploy",
  actor: "github:deploy-bot",
  environment: "production",
};

function jsonResponse(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

describe("GitHub Deploy Gate integration contract", () => {
  beforeEach(() => mockPost.mockReset());

  it("executes one governed deployment only after evaluation and permit verification", async () => {
    const timeline: string[] = [];
    mockPost
      .mockResolvedValueOnce(
        jsonResponse(200, {
          decision: "allow",
          evaluation_id: "eval-deploy-1",
          permit_token: "permit-deploy-1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { verified: true, outcome: "ok" }));

    const result = await enforce(CONFIG, async () => {
      timeline.push("deploy");
      return "deployed";
    });

    expect(result.result).toBe("deployed");
    expect(result.decision.evaluationId).toBe("eval-deploy-1");
    expect(result.verifyOutcome).toBe("ok");
    expect(mockPost.mock.calls.map((call) => call[0])).toEqual([
      "https://api.test/v1-evaluate",
      "https://api.test/v1-verify-permit",
    ]);
    expect(timeline).toEqual(["deploy"]);
  });

  it("blocks deployment when evaluation denies before permit verification", async () => {
    const timeline: string[] = [];
    mockPost.mockResolvedValueOnce(
      jsonResponse(200, { decision: "deny", deny_reason: "change freeze" }),
    );

    await expect(
      enforce(CONFIG, async () => {
        timeline.push("deploy");
      }),
    ).rejects.toMatchObject({ phase: "verify" });

    expect(timeline).toEqual([]);
    expect(mockPost.mock.calls[0][0]).toBe("https://api.test/v1-evaluate");
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("requires an allow decision to include a verifiable permit before deployment", async () => {
    const timeline: string[] = [];
    mockPost.mockResolvedValueOnce(
      jsonResponse(200, { decision: "allow", evaluation_id: "eval-no-permit" }),
    );

    await expect(
      enforce(CONFIG, async () => {
        timeline.push("deploy");
      }),
    ).rejects.toSatisfy(
      (error: EnforceError) =>
        error instanceof EnforceError &&
        error.phase === "verify-permit" &&
        error.message.includes("no permit_token"),
    );

    expect(timeline).toEqual([]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("prevents deployment when permit verification fails", async () => {
    const timeline: string[] = [];
    mockPost
      .mockResolvedValueOnce(
        jsonResponse(200, {
          decision: "allow",
          evaluation_id: "eval-replay",
          permit_token: "permit-replayed",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { verified: false, outcome: "permit_consumed" }),
      );

    await expect(
      enforce(CONFIG, async () => {
        timeline.push("deploy");
      }),
    ).rejects.toMatchObject({ phase: "verify-permit" });

    expect(timeline).toEqual([]);
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
