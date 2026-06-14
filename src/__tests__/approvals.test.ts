import { describe, expect, it, vi } from "vitest";
import { countApprovals, resolveApprovals } from "../approvals";

// A minimal fetch double: maps URL substrings to {status, json}.
function makeFetch(
  routes: Array<{ match: string; status?: number; body: unknown }>,
): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const review = (login: string, state: string) => ({ user: { login }, state });

describe("countApprovals", () => {
  it("counts one approval per distinct reviewer", () => {
    const out = countApprovals([review("alice", "APPROVED"), review("bob", "APPROVED")]);
    expect(out.approvals).toBe(2);
    expect(out.approving_reviewers).toEqual(["alice", "bob"]);
  });

  it("uses the latest stateful review per reviewer (re-approval)", () => {
    const out = countApprovals([
      review("alice", "CHANGES_REQUESTED"),
      review("alice", "APPROVED"),
    ]);
    expect(out.approvals).toBe(1);
    expect(out.approving_reviewers).toEqual(["alice"]);
  });

  it("a later CHANGES_REQUESTED supersedes an earlier APPROVED", () => {
    const out = countApprovals([
      review("alice", "APPROVED"),
      review("alice", "CHANGES_REQUESTED"),
    ]);
    expect(out.approvals).toBe(0);
  });

  it("a later DISMISSED removes the approval", () => {
    const out = countApprovals([review("alice", "APPROVED"), review("alice", "DISMISSED")]);
    expect(out.approvals).toBe(0);
  });

  it("ignores COMMENTED / PENDING (they do not change approval state)", () => {
    const out = countApprovals([
      review("alice", "APPROVED"),
      review("alice", "COMMENTED"),
      review("bob", "PENDING"),
    ]);
    expect(out.approvals).toBe(1);
    expect(out.approving_reviewers).toEqual(["alice"]);
  });

  it("ignores reviews with no user login", () => {
    const out = countApprovals([{ state: "APPROVED" }, review("bob", "APPROVED")]);
    expect(out.approvals).toBe(1);
    expect(out.approving_reviewers).toEqual(["bob"]);
  });

  it("returns zero for an empty review list", () => {
    expect(countApprovals([]).approvals).toBe(0);
  });
});

describe("resolveApprovals", () => {
  const base = {
    repository: "acme/web",
    sha: "abc123def456",
    apiBase: "https://api.github.com",
    token: "ghs_token",
  };

  it("fail-opens to zero when no token is available", async () => {
    const warn = vi.fn();
    const out = await resolveApprovals({ ...base, token: undefined, warn });
    expect(out).toEqual({ approvals: 0, approving_reviewers: [], pr_number: null, source: "none" });
    expect(warn).toHaveBeenCalled();
  });

  it("reads reviews for an explicit PR number (pull_request event)", async () => {
    const { fn, calls } = makeFetch([
      { match: "/pulls/42/reviews", body: [review("alice", "APPROVED"), review("bob", "APPROVED")] },
    ]);
    const out = await resolveApprovals({ ...base, prNumber: 42, fetchImpl: fn });
    expect(out.approvals).toBe(2);
    expect(out.pr_number).toBe(42);
    expect(out.source).toBe("pr-reviews");
    // Did not need the commit→pulls resolution call.
    expect(calls.some((c) => c.includes("/commits/"))).toBe(false);
  });

  it("resolves the PR from the head commit on a push/merge event", async () => {
    const { fn } = makeFetch([
      { match: `/commits/${base.sha}/pulls`, body: [{ number: 7, state: "closed" }] },
      { match: "/pulls/7/reviews", body: [review("alice", "APPROVED")] },
    ]);
    const out = await resolveApprovals({ ...base, prNumber: null, fetchImpl: fn });
    expect(out.pr_number).toBe(7);
    expect(out.approvals).toBe(1);
    expect(out.source).toBe("pr-reviews");
  });

  it("prefers a closed/merged PR over an open one when several match a commit", async () => {
    const { fn } = makeFetch([
      {
        match: `/commits/${base.sha}/pulls`,
        body: [
          { number: 9, state: "open" },
          { number: 8, state: "closed" },
        ],
      },
      { match: "/pulls/8/reviews", body: [review("alice", "APPROVED")] },
    ]);
    const out = await resolveApprovals({ ...base, fetchImpl: fn });
    expect(out.pr_number).toBe(8);
  });

  it("returns zero approvals (source none) when no PR is associated", async () => {
    const { fn } = makeFetch([{ match: `/commits/${base.sha}/pulls`, body: [] }]);
    const out = await resolveApprovals({ ...base, fetchImpl: fn });
    expect(out).toEqual({ approvals: 0, approving_reviewers: [], pr_number: null, source: "none" });
  });

  it("fail-opens to zero when the reviews API errors", async () => {
    const warn = vi.fn();
    const { fn } = makeFetch([{ match: "/pulls/42/reviews", status: 403, body: {} }]);
    const out = await resolveApprovals({ ...base, prNumber: 42, fetchImpl: fn, warn });
    expect(out.approvals).toBe(0);
    expect(out.pr_number).toBe(42);
    expect(out.source).toBe("none");
    expect(warn).toHaveBeenCalled();
  });

  it("fail-opens to zero when the reviews body is not JSON (never throws)", async () => {
    // Reproduces the real GH-Actions mock returning a plain "ok" body: res.json()
    // throws a SyntaxError, which must be swallowed rather than crashing the gate.
    const fn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token 'o', "ok" is not valid JSON`);
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const out = await resolveApprovals({ ...base, prNumber: 42, fetchImpl: fn });
    expect(out.approvals).toBe(0);
    expect(out.source).toBe("none");
  });

  it("fail-opens to zero when fetch throws", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const out = await resolveApprovals({ ...base, prNumber: 42, fetchImpl: throwing });
    expect(out.approvals).toBe(0);
  });

  it("sends the GitHub bearer token and API version header", async () => {
    const seen: Array<Record<string, string>> = [];
    const fn = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {});
      return { ok: true, status: 200, json: async () => [review("alice", "APPROVED")] } as unknown as Response;
    }) as unknown as typeof fetch;
    await resolveApprovals({ ...base, prNumber: 1, fetchImpl: fn });
    expect(seen[0]?.Authorization).toBe("Bearer ghs_token");
    expect(seen[0]?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});
