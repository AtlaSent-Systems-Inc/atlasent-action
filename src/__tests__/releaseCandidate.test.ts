import { describe, expect, it, vi } from "vitest";
import { registerAndVerify, summarizeOutcome } from "../releaseCandidate";

describe("registerAndVerify", () => {
  it("registers candidate then calls runtime + deploy verify in sequence", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/v1/release/candidates")) {
        return new Response(
          JSON.stringify({ success: true, data: { candidateId: "cand-1" } }),
          { status: 200 },
        );
      }
      if (url.endsWith("/cand-1/verify/runtime")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              verificationId: "v-rt",
              status: "passed",
              checks: [{ name: "status", status: "passed" }],
              summary: {},
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/cand-1/verify/deploy")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              verificationId: "v-dp",
              status: "passed",
              checks: [{ name: "deploy.commit_sha", status: "passed" }],
              summary: {},
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected: ${url}`);
    });

    const result = await registerAndVerify(
      {
        controlPlaneUrl: "https://cp.example",
        controlPlaneToken: "cp-tok",
        targetRuntimeUrl: "https://rt.example",
        repo: "org/repo",
        commitSha: "abcdef0",
        imageDigest: "sha256:x",
        semver: "1.0.0",
        environment: "staging",
      },
      fetchFn as unknown as typeof fetch,
    );

    expect(result.candidateId).toBe("cand-1");
    expect(result.runtime.status).toBe("passed");
    expect(result.deploy.status).toBe("passed");
    expect(calls.map((c) => c.url)).toEqual([
      "https://cp.example/v1/release/candidates",
      "https://cp.example/v1/release/candidates/cand-1/verify/runtime",
      "https://cp.example/v1/release/candidates/cand-1/verify/deploy",
    ]);
    // First call carries the candidate identity.
    expect(calls[0]?.body).toMatchObject({
      repo: "org/repo",
      commitSha: "abcdef0",
      imageDigest: "sha256:x",
      semver: "1.0.0",
      environment: "staging",
      targetRuntimeUrl: "https://rt.example",
    });
  });

  it("throws on non-2xx from the registration call", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("not authorized", { status: 401 }),
    );
    await expect(
      registerAndVerify(
        {
          controlPlaneUrl: "https://cp.example",
          controlPlaneToken: "bad",
          targetRuntimeUrl: "https://rt.example",
          repo: "org/repo",
          commitSha: "abcdef0",
          environment: "staging",
        },
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/POST .* failed \(401\)/);
  });

  it("strips trailing slash from controlPlaneUrl", async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push(url);
      if (url.endsWith("/v1/release/candidates")) {
        return new Response(
          JSON.stringify({ success: true, data: { candidateId: "c" } }),
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          data: { verificationId: "v", status: "passed", checks: [], summary: {} },
        }),
      );
    });
    await registerAndVerify(
      {
        controlPlaneUrl: "https://cp.example/",
        controlPlaneToken: "t",
        targetRuntimeUrl: "https://rt",
        repo: "r",
        commitSha: "s",
        environment: "preview",
      },
      fetchFn as unknown as typeof fetch,
    );
    // No double-slashes after the host.
    for (const u of seen) {
      const afterScheme = u.replace(/^https?:\/\//, "");
      expect(afterScheme).not.toMatch(/\/\//);
    }
  });
});

describe("summarizeOutcome", () => {
  it("passed → ok=true level=passed", () => {
    expect(summarizeOutcome({ status: "passed", checks: [], summary: {}, verificationId: "v" }))
      .toEqual({ ok: true, level: "passed" });
  });
  it("partial → ok=true level=warned", () => {
    expect(summarizeOutcome({ status: "partial", checks: [], summary: {}, verificationId: "v" }))
      .toEqual({ ok: true, level: "warned" });
  });
  it("failed → ok=false level=failed", () => {
    expect(summarizeOutcome({ status: "failed", checks: [], summary: {}, verificationId: "v" }))
      .toEqual({ ok: false, level: "failed" });
  });
  it("error → ok=false level=failed", () => {
    expect(summarizeOutcome({ status: "error", checks: [], summary: {}, verificationId: "v" }))
      .toEqual({ ok: false, level: "failed" });
  });
});
