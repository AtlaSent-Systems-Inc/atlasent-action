import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deliberately does NOT mock "../batch" — this file exercises the REAL
// evaluateMany()/bindTrustedStateSnapshot() so the wiring between
// evaluateMany()'s bound items and runV21()'s emitBatchEvidence() call is
// actually exercised end-to-end, not short-circuited by a mock that would
// hide the bug this test guards against.
//
// Codex finding on #148/#161: bindTrustedStateSnapshot() correctly
// overrides caller-forged context.repository/ref/sha for the EVALUATE
// call, but runV21() previously passed its own pre-bind `items` — not
// evaluateMany()'s returned (bound) items — into emitBatchEvidence(),
// which spreads `item.context` directly into the authenticated
// `execution_started` audit event. That let a caller-forged
// context.repository/ref survive into the audit trail even though the
// evaluation itself was correctly bound. Fixed by evaluateMany()
// returning the bound items on BatchResult and runV21() using THOSE
// (`batch.items`, aliased `boundItems`) for both the wait-for-id verify
// lookup and emitBatchEvidence() — see src/batch.ts and src/v21.ts.

vi.mock("@atlasent/enforce", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlasent/enforce")>();
  return { ...actual, verifyPermit: vi.fn() };
});
vi.mock("../evidenceClient", () => ({ emitEvidenceEvent: vi.fn(async () => {}) }));
vi.mock("../workloadIdentity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workloadIdentity")>();
  return { ...actual, mintGithubActionsActorIdentity: vi.fn() };
});

import { runV21 } from "../v21";
import { verifyPermit } from "@atlasent/enforce";
import { emitEvidenceEvent } from "../evidenceClient";
import { mintGithubActionsActorIdentity } from "../workloadIdentity";

const mockVerifyPermit = verifyPermit as ReturnType<typeof vi.fn>;
const mockEmitEvidence = emitEvidenceEvent as ReturnType<typeof vi.fn>;
const mockMintIdentity = mintGithubActionsActorIdentity as ReturnType<typeof vi.fn>;

const TRUSTED_ENV = {
  GITHUB_REPOSITORY: "AtlaSent-Systems-Inc/atlasent-action",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "1111111111111111111111111111111111111111",
  GITHUB_RUN_ID: "777",
};

const fetchMock = vi.fn();

function evalResp(decision = "allow", permitToken = "tok1") {
  return new Response(
    JSON.stringify({ decision, evaluatedAt: "2026-04-25T00:00:00Z", permitToken, id: "eval-1" }),
  );
}

describe("runV21 threads evaluateMany's BOUND items into emitBatchEvidence (issue #148 Codex finding)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mockVerifyPermit.mockReset();
    mockEmitEvidence.mockReset();
    mockEmitEvidence.mockImplementation(async () => {});
    mockMintIdentity.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_REPOSITORY", TRUSTED_ENV.GITHUB_REPOSITORY);
    vi.stubEnv("GITHUB_REF", TRUSTED_ENV.GITHUB_REF);
    vi.stubEnv("GITHUB_SHA", TRUSTED_ENV.GITHUB_SHA);
    vi.stubEnv("GITHUB_RUN_ID", TRUSTED_ENV.GITHUB_RUN_ID);

    mockMintIdentity.mockResolvedValue({
      actorId: "workload:github:repo-1:workflow-1",
      assertion: { version: "actor_identity.v1", token: "signed-1" },
      source: {
        issuer: "https://token.actions.githubusercontent.com",
        repository: TRUSTED_ENV.GITHUB_REPOSITORY,
        repository_id: "repo-1",
        ref: TRUSTED_ENV.GITHUB_REF,
        sha: TRUSTED_ENV.GITHUB_SHA,
        workflow_ref: `${TRUSTED_ENV.GITHUB_REPOSITORY}/.github/workflows/deploy.yml@${TRUSTED_ENV.GITHUB_REF}`,
        actor: "octocat",
        actor_id: "actor-1",
        run_id: TRUSTED_ENV.GITHUB_RUN_ID,
        run_attempt: "1",
        environment: "production",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does NOT let a forged context.repository/ref/sha survive into the emitted execution_started evidence", async () => {
    fetchMock.mockResolvedValueOnce(evalResp("allow", "tok-evidence"));
    mockVerifyPermit.mockResolvedValueOnce({ verified: true, outcome: "ok" });

    const env = {
      ATLASENT_API_KEY: "ask_test_key",
      "INPUT_API-URL": "https://api.test",
      "INPUT_FAIL-ON-DENY": "true",
      INPUT_EVALUATIONS: JSON.stringify([
        {
          action: "production.deploy",
          actor: "caller",
          environment: "production",
          // Forged: an attacker-controlled workflow trying to claim a
          // different repository/ref/sha than what's actually running.
          context: {
            repository: "attacker-org/definitely-not-this-repo",
            ref: "refs/heads/malicious-unreviewed-branch",
            sha: "0000000000000000000000000000000000000000",
          },
        },
      ]),
    };

    const out = await runV21(env, { v2Streaming: false });

    expect(out.failed).toBe(false);
    expect(mockEmitEvidence).toHaveBeenCalledTimes(1);

    const [, payload] = mockEmitEvidence.mock.calls[0];
    const metadata = (payload as { metadata: Record<string, unknown> }).metadata;

    // The forged values must NOT appear anywhere in the emitted evidence.
    expect(metadata["repository"]).not.toBe("attacker-org/definitely-not-this-repo");
    expect(metadata["ref"]).not.toBe("refs/heads/malicious-unreviewed-branch");
    expect(metadata["sha"]).not.toBe("0000000000000000000000000000000000000000");

    // The REAL, GitHub-derived values — the same ones bindTrustedStateSnapshot()
    // bound for the evaluate call — must appear instead.
    expect(metadata["repository"]).toBe(TRUSTED_ENV.GITHUB_REPOSITORY);
    expect(metadata["ref"]).toBe(TRUSTED_ENV.GITHUB_REF);
    expect(metadata["sha"]).toBe(TRUSTED_ENV.GITHUB_SHA);

    // And the actual /v1-evaluate call itself carried the same trusted values
    // (proving evaluate and evidence agree — the whole point of this fix).
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.context.repository).toBe(TRUSTED_ENV.GITHUB_REPOSITORY);
    expect(sentBody.context.ref).toBe(TRUSTED_ENV.GITHUB_REF);
  });
});
