import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_ACTIONS_OIDC_AUDIENCE,
  WorkloadIdentityError,
  mintGithubActionsActorIdentity,
} from "../workloadIdentity";

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.example/token?api-version=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
};

const ASSERTION = {
  version: "actor_identity.v1",
  subject: { principal_id: "github-actions:123:workflow", principal_kind: "workload" },
};

const SOURCE = {
  issuer: "https://token.actions.githubusercontent.com" as const,
  repository: "AtlaSent-Systems-Inc/app",
  repository_id: "123",
  ref: "refs/heads/main",
  sha: "abc123",
  workflow_ref: "AtlaSent-Systems-Inc/app/.github/workflows/deploy.yml@refs/heads/main",
  actor: "bettyc925",
  actor_id: "112233",
  run_id: "778899",
  run_attempt: "1",
  environment: "production",
};

function okFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oidc.actions.example/token")) {
      expect(new URL(url).searchParams.get("audience")).toBe(GITHUB_ACTIONS_OIDC_AUDIENCE);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer request-secret",
      );
      return new Response(JSON.stringify({ value: "header.payload.signature" }));
    }
    expect(url).toBe("https://runtime.example/functions/v1/v1-idp-broker/mint/actor-identity");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ask_live_key");
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: "github_actions",
      id_token: "header.payload.signature",
      action_type: "production.deploy",
      environment: "production",
    });
    return new Response(
      JSON.stringify({
        kind: "actor_identity.v1",
        actor_id: "github-actions:123:workflow",
        assertion: ASSERTION,
        source: SOURCE,
      }),
    );
  });
}

describe("mintGithubActionsActorIdentity", () => {
  it("exchanges the job OIDC token for a runtime-minted assertion", async () => {
    const fetchImpl = okFetch();
    const masked: string[] = [];
    const result = await mintGithubActionsActorIdentity(
      {
        apiUrl: "https://runtime.example/functions/v1/",
        apiKey: "ask_live_key",
        actionType: "production.deploy",
        environment: "production",
      },
      { fetchImpl: fetchImpl as typeof fetch, env: ENV, mask: (value) => masked.push(value) },
    );

    expect(result).toEqual({
      actorId: "github-actions:123:workflow",
      assertion: ASSERTION,
      source: SOURCE,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(masked).toEqual(["request-secret", "header.payload.signature"]);
  });

  it("fails closed with a permission hint when GitHub does not expose OIDC", async () => {
    await expect(
      mintGithubActionsActorIdentity(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "k",
          actionType: "production.deploy",
          environment: "production",
        },
        { fetchImpl: vi.fn() as unknown as typeof fetch, env: {} },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkloadIdentityError && error.message.includes("id-token: write"),
    );
  });

  it("fails closed when GitHub rejects the token request", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      mintGithubActionsActorIdentity(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "k",
          actionType: "production.deploy",
          environment: "production",
        },
        { fetchImpl: fetchImpl as typeof fetch, env: ENV },
      ),
    ).rejects.toThrow(/GitHub OIDC token request failed \(HTTP 403\)/);
  });

  it("fails closed when the broker rejects the verified job binding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "jwt" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "github_actions_binding_mismatch" }), { status: 403 }),
      );
    await expect(
      mintGithubActionsActorIdentity(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "k",
          actionType: "production.deploy",
          environment: "production",
        },
        { fetchImpl: fetchImpl as typeof fetch, env: ENV },
      ),
    ).rejects.toThrow(/binding_mismatch/);
  });

  it("rejects a malformed successful broker response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "jwt" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ actor_id: "caller-value" })));
    await expect(
      mintGithubActionsActorIdentity(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "k",
          actionType: "production.deploy",
          environment: "production",
        },
        { fetchImpl: fetchImpl as typeof fetch, env: ENV },
      ),
    ).rejects.toThrow(/invalid actor_identity\.v1 response/);
  });
});
