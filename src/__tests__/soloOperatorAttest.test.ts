import { describe, expect, it, vi } from "vitest";
import {
  SoloOperatorAttestError,
  attestSoloOperator,
  productionDeployChangePlan,
} from "../soloOperatorAttest";
import { GITHUB_ACTIONS_OIDC_AUDIENCE } from "../workloadIdentity";

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.example/token?api-version=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
};

const ASSERTION = {
  version: "actor_identity.v1",
  subject: { principal_id: "github-actions:123:solo_operator.attest", principal_kind: "workload" },
};

function sourceWithSha(sha: string) {
  return {
    issuer: "https://token.actions.githubusercontent.com" as const,
    repository: "AtlaSent-Systems-Inc/app",
    repository_id: "123",
    ref: "refs/heads/main",
    sha,
    workflow_ref: "AtlaSent-Systems-Inc/app/.github/workflows/deploy.yml@refs/heads/main",
    actor: "bettyc925",
    actor_id: "112233",
    run_id: "778899",
    run_attempt: "1",
    environment: "",
  };
}

function mintFetchMock(sha: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oidc.actions.example/token")) {
      // The mint is bound to solo_operator.attest, not the target action_type.
      expect(new URL(url).searchParams.get("audience")).toBe(GITHUB_ACTIONS_OIDC_AUDIENCE);
      return new Response(JSON.stringify({ value: "header.payload.signature" }));
    }
    expect(url).toBe("https://runtime.example/functions/v1/v1-idp-broker/mint/actor-identity");
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: "github_actions",
      id_token: "header.payload.signature",
      action_type: "solo_operator.attest",
      environment: "",
    });
    return new Response(
      JSON.stringify({
        kind: "actor_identity.v1",
        actor_id: "github-actions:123:solo_operator.attest",
        assertion: ASSERTION,
        source: sourceWithSha(sha),
      }),
    );
  });
}

describe("productionDeployChangePlan", () => {
  it("derives operation/revision/artifact_ref exactly as index.ts's main evaluate path does", () => {
    expect(productionDeployChangePlan("a".repeat(40), "sha256:digest")).toEqual({
      operation: "deploy",
      revision: "a".repeat(40),
      artifact_ref: "sha256:digest",
    });
    expect(productionDeployChangePlan("a".repeat(40), undefined)).toEqual({
      operation: "deploy",
      revision: "a".repeat(40),
    });
  });
});

describe("attestSoloOperator", () => {
  it("rejects a non-production.deploy action type with no evidence_profile, before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(
      attestSoloOperator(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "k",
          actionType: "control.override",
          actionClassId: "ac-1",
          commitSha: "a".repeat(40),
          attestationReason: "Solo founder disabling a WAF rule during an active incident.",
        },
        { fetchImpl: fetchImpl as typeof fetch, env: ENV },
      ),
    ).rejects.toBeInstanceOf(SoloOperatorAttestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("production.deploy: derives change_plan.revision from the VERIFIED mint response, never a caller-supplied value, and posts it", async () => {
    const sha = "b".repeat(40);
    const mintFetch = mintFetchMock(sha);
    const attestFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://runtime.example/functions/v1/v1-solo-operator-attest");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["action_class_id"]).toBe("ac-1");
      expect(body["commit_sha"]).toBe(sha);
      expect(body["attestation_reason"]).toBe("Solo founder deploy; CI green and staging accepted.");
      expect(body["actor_identity"]).toEqual(ASSERTION);
      expect(body["change_plan"]).toEqual({
        operation: "deploy",
        revision: sha,
        artifact_ref: "sha256:artifact",
      });
      expect(body["evidence_profile"]).toBeUndefined();
      expect(body["target_id"]).toBe("svc-a");
      expect(body["environment"]).toBe("production");
      return new Response(
        JSON.stringify({
          attestation: {
            id: "att-1",
            attested_by: "solo-operator",
            change_plan_hash: "0".repeat(64),
          },
        }),
        { status: 201 },
      );
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("v1-solo-operator-attest")) return attestFetch(input, init);
      return mintFetch(input, init);
    });

    const result = await attestSoloOperator(
      {
        apiUrl: "https://runtime.example/functions/v1",
        apiKey: "ask_live_key",
        actionType: "production.deploy",
        actionClassId: "ac-1",
        commitSha: sha,
        attestationReason: "Solo founder deploy; CI green and staging accepted.",
        targetId: "svc-a",
        environment: "production",
        artifactDigest: "sha256:artifact",
      },
      { fetchImpl: fetchImpl as typeof fetch, env: ENV },
    );

    expect(result).toEqual({
      attestationId: "att-1",
      attestedBy: "solo-operator",
      changePlanHash: "0".repeat(64),
    });
    expect(attestFetch).toHaveBeenCalledTimes(1);
  });

  it("non-production.deploy: posts the supplied evidence_profile, never a change_plan", async () => {
    const sha = "c".repeat(40);
    const mintFetch = mintFetchMock(sha);
    const evidenceProfile = {
      kind: "control_override",
      control_id: "waf-rule-442",
      override_scope: "inbound traffic only, api.example.com",
      reason: "Active incident INC-1029.",
      expires_at: "2026-08-30T13:00:00Z",
    };
    const attestFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["evidence_profile"]).toEqual(evidenceProfile);
      expect(body["change_plan"]).toBeUndefined();
      return new Response(
        JSON.stringify({
          attestation: { id: "att-2", attested_by: "solo-operator", change_plan_hash: "1".repeat(64) },
        }),
        { status: 201 },
      );
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("v1-solo-operator-attest")) return attestFetch(input, init);
      return mintFetch(input, init);
    });

    const result = await attestSoloOperator(
      {
        apiUrl: "https://runtime.example/functions/v1",
        apiKey: "ask_live_key",
        actionType: "control.override",
        actionClassId: "ac-2",
        commitSha: sha,
        attestationReason: "Solo founder disabling a WAF rule during an active incident.",
        evidenceProfile,
      },
      { fetchImpl: fetchImpl as typeof fetch, env: ENV },
    );
    expect(result.attestationId).toBe("att-2");
  });

  it("fails closed when the mint step fails", async () => {
    await expect(
      attestSoloOperator(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "k",
          actionType: "production.deploy",
          actionClassId: "ac-1",
          commitSha: "a".repeat(40),
          attestationReason: "Solo founder deploy.",
        },
        { fetchImpl: vi.fn() as unknown as typeof fetch, env: {} },
      ),
    ).rejects.toBeInstanceOf(SoloOperatorAttestError);
  });

  it("fails closed when the attest endpoint rejects the request", async () => {
    const sha = "d".repeat(40);
    const mintFetch = mintFetchMock(sha);
    const attestFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not_provisioned" }), { status: 409 }),
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("v1-solo-operator-attest")) return attestFetch();
      return mintFetch(input, init);
    });

    await expect(
      attestSoloOperator(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "ask_live_key",
          actionType: "production.deploy",
          actionClassId: "ac-1",
          commitSha: sha,
          attestationReason: "Solo founder deploy.",
        },
        { fetchImpl: fetchImpl as typeof fetch, env: ENV },
      ),
    ).rejects.toThrow(/not_provisioned/);
  });

  it("rejects a malformed successful attest response (missing fields)", async () => {
    const sha = "e".repeat(40);
    const mintFetch = mintFetchMock(sha);
    const attestFetch = vi.fn(
      async () => new Response(JSON.stringify({ attestation: { id: "att-3" } }), { status: 201 }),
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("v1-solo-operator-attest")) return attestFetch();
      return mintFetch(input, init);
    });

    await expect(
      attestSoloOperator(
        {
          apiUrl: "https://runtime.example/functions/v1",
          apiKey: "ask_live_key",
          actionType: "production.deploy",
          actionClassId: "ac-1",
          commitSha: sha,
          attestationReason: "Solo founder deploy.",
        },
        { fetchImpl: fetchImpl as typeof fetch, env: ENV },
      ),
    ).rejects.toThrow(/incomplete attestation record/);
  });
});
