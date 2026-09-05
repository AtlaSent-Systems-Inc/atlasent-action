// Wave B.AC2 / B.AC4 — batch fan-out helper with per-decision verify-permit.
//
// When the per-tenant `v2Batch` flag is on, posts a single batch to
// /v1-evaluate/batch. Otherwise, per-item /v1-evaluate loop. Either
// path then runs verify-permit for every allow decision, matching the
// single-eval runGate() contract — the gate is fail-closed end-to-end.
//
// Uses @atlasent/enforce's verifyPermit() as the canonical implementation.
//
// Wave B hardening (V2-D3 contract alignment):
//   • items < 2 → skip batch entirely, use per-item loop (no benefit).
//   • items > 100 → chunk into ≤100-item batches (server hard-cap).
//   • 404 from /v1-evaluate/batch → automatic fallback to per-item loop
//     (v2_batch tenant flag is off; closed-by-default behavior).

import { verifyPermit, requiredBindingsFor } from "@atlasent/enforce";
import type { EvaluateRequest } from "./types";
import type { Decision } from "./types";
import { PRODUCTION_DEPLOY_ACTION } from "./canonicalAction";

/**
 * Server-enforced cap from V2-D3: `/v1-evaluate/batch` rejects requests
 * with more than 100 items via `413 batch_too_large`. Mirror it here so
 * we chunk client-side rather than discovering the limit at runtime.
 */
export const BATCH_MAX_ITEMS = 100;

// ---------------------------------------------------------------------------
// Trusted state_snapshot binding (issue #148)
//
// A post-merge audit of #138 found that the single-evaluation production
// path (src/index.ts's `config.state_snapshot` + its
// `context: { ...extraContext, repository: gh.repository, ref: gh.ref,
// sha: gh.sha, ... }` construction) requires a GitHub-derived state_snapshot
// and trusted repository/ref/sha context for every evaluate call, discarding
// anything the caller supplied for those keys — but the batch path posted
// every `evaluations:` item to /v1-evaluate(/batch) completely unmodified,
// so a batch caller could self-assert (or simply omit) `state_snapshot`,
// `context.repository`, `context.ref`, and `context.sha` for a
// production.deploy item, silently bypassing the trusted-GitHub-state
// binding the single path enforces.
//
// bindTrustedStateSnapshot() closes that gap by applying the EXACT SAME
// contract to every production.deploy batch item, run once inside
// evaluateMany() so it covers every dispatch route (the /v1-evaluate/batch
// endpoint, its chunking, and the per-item loop fallback) uniformly:
//   - any caller-supplied `state_snapshot` — top-level on the item, or
//     nested inside `context` — is discarded, never forwarded;
//   - `context.repository` / `.ref` / `.sha` / `.workflow` / `.run_id` /
//     `.run_number` / `.event_name` are always overwritten with the real
//     values read from the GitHub Actions runner environment (the same
//     env vars src/index.ts's private `getGitHubContext()` reads),
//     regardless of what a caller supplied for those keys — matching the
//     single path's "operator context is spread first, trusted fields
//     always win" ordering;
//   - `state_snapshot` is (re)constructed fresh from that same trusted
//     environment, matching src/index.ts's shape exactly:
//     `{ source: "github-actions", complete: true, run_id }`.
//
// Scoped to production.deploy items only, mirroring the existing
// production-only gate in v21.ts's bindBatchWorkloadIdentities() — a
// non-production item is returned untouched.
//
// Deliberately duplicates (rather than imports) the GITHUB_* env read:
// src/index.ts's GitHubContext/getGitHubContext are private to the CLI
// entrypoint and not exported, and this module must not take on a runtime
// dependency on that file.
// ---------------------------------------------------------------------------

interface TrustedGithubState {
  repository: string;
  ref: string;
  sha: string;
  workflow: string;
  run_id: string;
  run_number: string;
  event_name: string;
}

function readTrustedGithubState(): TrustedGithubState {
  return {
    repository: process.env["GITHUB_REPOSITORY"] ?? "",
    ref: process.env["GITHUB_REF"] ?? "",
    sha: process.env["GITHUB_SHA"] ?? "",
    workflow: process.env["GITHUB_WORKFLOW"] ?? "",
    run_id: process.env["GITHUB_RUN_ID"] ?? "",
    run_number: process.env["GITHUB_RUN_NUMBER"] ?? "",
    event_name: process.env["GITHUB_EVENT_NAME"] ?? "",
  };
}

/**
 * Bind every production.deploy item in `items` to a GitHub-derived
 * `state_snapshot` and trusted repository/ref/sha/workflow/run context,
 * discarding any caller-supplied values for those specific keys. See the
 * module header above for the full contract. Exported for direct unit
 * testing; also exercised indirectly through evaluateMany().
 */
export function bindTrustedStateSnapshot(items: EvaluateRequest[]): EvaluateRequest[] {
  if (!items.some((item) => item.action === PRODUCTION_DEPLOY_ACTION)) {
    return items;
  }

  const state = readTrustedGithubState();

  return items.map((item) => {
    if (item.action !== PRODUCTION_DEPLOY_ACTION) {
      return item;
    }

    // Discard any caller-supplied state_snapshot, top-level or nested in
    // context — a malformed or self-authored value must never reach the
    // wire; only the freshly-derived one below is ever sent.
    const { state_snapshot: _discardedTopLevelSnapshot, context, ...rest } = item;
    const safeContext: Record<string, unknown> = { ...(context ?? {}) };
    delete safeContext["state_snapshot"];

    return {
      ...rest,
      context: {
        ...safeContext,
        // Trusted fields always win over whatever the caller's `context`
        // claimed for these keys — a batch item asserting a wrong
        // repository or wrong ref must never survive past this point.
        repository: state.repository,
        ref: state.ref,
        sha: state.sha,
        workflow: state.workflow,
        run_id: state.run_id,
        run_number: state.run_number,
        event_name: state.event_name,
      },
      state_snapshot: {
        source: "github-actions",
        complete: true,
        run_id: state.run_id,
      },
    };
  });
}

/**
 * Below this threshold, the batch endpoint provides no benefit (it adds
 * a round-trip and a server-side fan-out for nothing) so we short-circuit
 * straight to the per-item /v1-evaluate path.
 */
export const BATCH_MIN_ITEMS = 2;

export interface BatchResult {
  decisions: Decision[];
  /** Originating batchId, or `loop-<ts>` when the loop fallback ran. */
  batchId: string;
}

export async function evaluateMany(
  apiUrl: string,
  apiKey: string,
  rawItems: EvaluateRequest[],
  v2Batch: boolean,
): Promise<BatchResult> {
  // Bind every production.deploy item to a trusted, GitHub-derived
  // state_snapshot/context BEFORE any dispatch decision below, so every
  // route (the /v1-evaluate/batch endpoint, its chunking, and the
  // per-item loop fallback) sends the same trusted contract the
  // single-eval path enforces. See bindTrustedStateSnapshot()'s header.
  const items = bindTrustedStateSnapshot(rawItems);

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  let decisions: Decision[];
  let batchId: string;

  // Short-circuit: a "batch" of 0 or 1 items has no fan-out advantage
  // over the single-item endpoint, and skipping the batch hop also
  // avoids the v2_batch tenant-flag 404 round-trip for single-item
  // callers using the runV21 wrapper.
  const shouldUseBatch = v2Batch && items.length >= BATCH_MIN_ITEMS;

  if (shouldUseBatch) {
    try {
      const out = await postBatchChunked(apiUrl, headers, items);
      decisions = out.decisions;
      batchId = out.batchId;
    } catch (err) {
      // 404 from /v1-evaluate/batch means the tenant doesn't have the
      // `v2_batch` flag flipped on yet (V2-D3 closed-by-default). Fall
      // back to the per-item /v1-evaluate loop so the workflow still
      // succeeds — the per-item path is fail-closed in the same way.
      if (err instanceof BatchEndpointDisabled) {
        const out = await loopEvaluate(apiUrl, headers, items);
        decisions = out.decisions;
        batchId = out.batchId;
      } else {
        throw err;
      }
    }
  } else {
    const out = await loopEvaluate(apiUrl, headers, items);
    decisions = out.decisions;
    batchId = out.batchId;
  }

  // Verify permits for every allow decision using the canonical verifyPermit()
  // from @atlasent/enforce. Fail-closed: if any verify throws, the error
  // propagates up.
  const verified = await Promise.all(
    decisions.map(async (d, i) => {
      if (d.decision !== "allow" || !d.permitToken) {
        return { ...d, verified: d.decision === "allow" ? false : undefined };
      }
      const item = items[i];
      const runtimeExecutionHash =
        d.executionHashExpected ?? d.execution_hash_expected;
      // Re-bind the SAME environment / target / artifact digest this item was
      // evaluated with, and REQUIRE each at verify (fail-closed). Previously the
      // batch verify sent only {action,actor} — an unbound verify that a cross-item,
      // wrong-environment, or artifact-substituted permit could still satisfy.
      const enforceConfig = {
        apiKey,
        apiUrl,
        action: item.action,
        actor: item.actor,
        environment: item.environment,
        targetId: item.target_id,
        executionPayloadHash: runtimeExecutionHash ?? item.execution_payload_hash,
        requiredBindings: requiredBindingsFor({
          environment: item.environment,
          targetId: item.target_id,
          executionPayloadHash: runtimeExecutionHash ?? item.execution_payload_hash,
        }),
      };
      const enforceDecision = {
        decision: "allow" as const,
        permitToken: d.permitToken,
        executionHashExpected: runtimeExecutionHash,
      };
      const result = await verifyPermit(enforceConfig, enforceDecision);
      return { ...d, verified: result.verified, verifyOutcome: result.outcome };
    }),
  );

  return { decisions: verified, batchId };
}

/** Marker error: batch endpoint returned 404 → fall back to per-item loop. */
class BatchEndpointDisabled extends Error {
  constructor() {
    super("v1-evaluate/batch disabled for this tenant (404)");
    this.name = "BatchEndpointDisabled";
  }
}

/**
 * POST one or more batches to /v1-evaluate/batch, chunked to
 * BATCH_MAX_ITEMS. Decisions are concatenated in input order. The
 * returned batchId is the first chunk's batchId (or a synthetic
 * `chunked-<ts>` when there are multiple chunks, so downstream
 * audit references aren't misleadingly pinned to chunk 0).
 *
 * Throws `BatchEndpointDisabled` on the FIRST 404 so the caller can
 * fall back to the per-item loop without partial state. Any other
 * non-2xx throws a generic Error.
 */
async function postBatchChunked(
  apiUrl: string,
  headers: Record<string, string>,
  items: EvaluateRequest[],
): Promise<BatchResult> {
  const chunks: EvaluateRequest[][] = [];
  for (let i = 0; i < items.length; i += BATCH_MAX_ITEMS) {
    chunks.push(items.slice(i, i + BATCH_MAX_ITEMS));
  }

  const all: Decision[] = [];
  let firstBatchId = "";

  for (let c = 0; c < chunks.length; c++) {
    const r = await fetch(`${apiUrl}/v1-evaluate/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: chunks[c] }),
    });
    if (r.status === 404) {
      throw new BatchEndpointDisabled();
    }
    if (!r.ok) {
      throw new Error(`atlasent /v1-evaluate/batch ${r.status}`);
    }
    const data = (await r.json()) as { results: Decision[]; batchId: string };
    all.push(...data.results);
    if (c === 0) firstBatchId = data.batchId;
  }

  const batchId = chunks.length > 1 ? `chunked-${Date.now()}` : firstBatchId;
  return { decisions: all, batchId };
}

/**
 * Per-item /v1-evaluate loop. Used when:
 *   • v2Batch=false (caller didn't opt in), or
 *   • items.length < BATCH_MIN_ITEMS (no batch benefit), or
 *   • /v1-evaluate/batch returned 404 (v2_batch tenant flag off).
 */
async function loopEvaluate(
  apiUrl: string,
  headers: Record<string, string>,
  items: EvaluateRequest[],
): Promise<BatchResult> {
  const decisions: Decision[] = [];
  for (const item of items) {
    const r = await fetch(`${apiUrl}/v1-evaluate`, {
      method: "POST",
      headers,
      body: JSON.stringify(item),
    });
    if (!r.ok) {
      throw new Error(`atlasent /v1-evaluate ${r.status}`);
    }
    decisions.push((await r.json()) as Decision);
  }
  return { decisions, batchId: `loop-${Date.now()}` };
}
