// Post-deploy release candidate registration + verification.
//
// Wires into the atlasent-control-plane release surface added in
// AtlaSent-Systems-Inc/atlasent-control-plane#65:
//   POST   /v1/release/candidates
//   POST   /v1/release/candidates/:id/verify/runtime
//   POST   /v1/release/candidates/:id/verify/deploy
//
// Runs as a separate workflow step AFTER the deploy completes. The
// gate step (single-eval / batch) still runs BEFORE deploy; this is
// purely post-deploy attestation against the running runtime.
//
// Fail-closed: any transport or HTTP error throws so the workflow
// step fails. Verification failures (non-2xx OR outcome status
// "failed"/"error") fail the step unless fail-on-verify=false.

export interface ReleaseInputs {
  controlPlaneUrl: string;
  controlPlaneToken: string;
  targetRuntimeUrl: string;
  repo: string;
  commitSha: string;
  imageDigest?: string;
  semver?: string;
  environment: "preview" | "staging" | "production";
}

export interface VerificationOutcome {
  status: "passed" | "failed" | "partial" | "error";
  checks: Array<{ name: string; status: string; detail?: string }>;
  summary: Record<string, unknown>;
  verificationId: string;
}

export interface ReleaseResult {
  candidateId: string;
  runtime: VerificationOutcome;
  deploy: VerificationOutcome;
}

interface Envelope<T> {
  success: true;
  data: T;
}

async function postJson<T>(
  url: string,
  token: string,
  body: unknown,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  try {
    const parsed = JSON.parse(text) as Envelope<T> | T;
    if (parsed && typeof parsed === "object" && "data" in parsed && (parsed as Envelope<T>).success) {
      return (parsed as Envelope<T>).data;
    }
    return parsed as T;
  } catch {
    throw new Error(`POST ${url} returned non-JSON body: ${text.slice(0, 200)}`);
  }
}

export async function registerAndVerify(
  inputs: ReleaseInputs,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ReleaseResult> {
  const base = inputs.controlPlaneUrl.replace(/\/$/, "");

  const registered = await postJson<{ candidateId: string }>(
    `${base}/v1/release/candidates`,
    inputs.controlPlaneToken,
    {
      repo: inputs.repo,
      commitSha: inputs.commitSha,
      imageDigest: inputs.imageDigest,
      semver: inputs.semver,
      environment: inputs.environment,
      targetRuntimeUrl: inputs.targetRuntimeUrl,
    },
    fetchFn,
  );

  const runtime = await postJson<VerificationOutcome>(
    `${base}/v1/release/candidates/${registered.candidateId}/verify/runtime`,
    inputs.controlPlaneToken,
    {},
    fetchFn,
  );

  const deploy = await postJson<VerificationOutcome>(
    `${base}/v1/release/candidates/${registered.candidateId}/verify/deploy`,
    inputs.controlPlaneToken,
    {},
    fetchFn,
  );

  return { candidateId: registered.candidateId, runtime, deploy };
}

// Treats both "passed" outcomes as success. "partial" passes
// (runtime didn't report a comparable field) but emits a warning. Any
// "failed" or "error" outcome ⇒ failure.
export function summarizeOutcome(o: VerificationOutcome): {
  ok: boolean;
  level: "passed" | "warned" | "failed";
} {
  if (o.status === "passed") return { ok: true, level: "passed" };
  if (o.status === "partial") return { ok: true, level: "warned" };
  return { ok: false, level: "failed" };
}
