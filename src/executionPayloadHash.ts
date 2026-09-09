/**
 * Normalizes a caller-supplied artifact digest into the bare lowercase-hex
 * form atlasent-api's `v1-evaluate` handler requires before it will bind a
 * caller-supplied `execution_payload_hash` into a permit's signed
 * `execution_hash_expected` claim (handler.ts's bare-hex check,
 * `/^[0-9a-f]{64}$/i` — no `algo:` prefix accepted).
 *
 * `artifact-digest` is documented and commonly supplied in OCI form
 * (`sha256:<64-hex>`, e.g. from a container registry push or the
 * `sha256sum`-of-a-tarball convention this repo's own README examples use)
 * for the `MANDATORY_CHANGE_CONTROL_ACTIONS` `change_plan.artifact_ref`
 * path, where atlasent-api stores it as an opaque string with no format
 * requirement. But a non-mandatory-change-control action type (currently
 * only `package.release` — see canonicalAction.ts's own comment on why it
 * is deliberately excluded from `MANDATORY_CHANGE_CONTROL_ACTIONS`)
 * forwards that same `artifact-digest` input directly as
 * `executionPayloadHash`, which *does* have the bare-hex requirement.
 *
 * An OCI-prefixed value silently fails that regex server-side, so
 * `v1-evaluate` never binds `execution_hash_expected` and never echoes it
 * back — there is no way for the client to detect the failure at evaluate
 * time. Boundary verify then falls back to comparing against
 * `evaluation.payload_hash` (an unrelated, unreproducible hash of the whole
 * evaluate request body), which can never match: a deterministic
 * `PAYLOAD_MISMATCH` on every verify, every time, for every
 * `package.release` call that supplies an OCI-form digest.
 *
 * Strips a leading `<algo>:` prefix (case-insensitively) before comparing.
 * If what remains isn't a bare 64-char hex string, the input is returned
 * completely unchanged rather than guessed at further — an unrecognized
 * shape should fail exactly as it did before this normalization existed,
 * not be silently mangled into something new.
 *
 * Deliberately NOT applied to `change_plan.artifact_ref` construction (see
 * the two call sites in index.ts) — that field has no such format
 * requirement, and it already works correctly with the OCI-prefixed form
 * for `MANDATORY_CHANGE_CONTROL_ACTIONS` types; normalizing it too would be
 * an unreviewed, unrelated change to a binding that isn't broken.
 */
export function normalizeExecutionPayloadHash(digest: string | undefined): string | undefined {
  if (!digest) return digest;
  const colonIndex = digest.indexOf(":");
  const stripped = colonIndex === -1 ? digest : digest.slice(colonIndex + 1);
  return /^[0-9a-f]{64}$/i.test(stripped) ? stripped.toLowerCase() : digest;
}
