# AtlaSent Control System Roadmap — atlasent-action

> **Role:** GitHub Action that gates workflows via `POST /v1/evaluate`. Already fail-closed (per audit: `src/index.ts:7-51` — `core.setFailed()` on network error or deny). M3 tightens the contract; M4 documents how to make this unavoidable.
>
> **Master plan:** `atlasent-systems-inc/atlasent:docs/CONTROL-SYSTEM-ROADMAP.md`
>
> **Branch:** `claude/audit-atlasent-system-lhVC5`

## Ground truth (from audit)
- `src/index.ts:7-48` — fetches `/v1/evaluate`, fail-closed on non-2xx or network error.
- `src/index.ts:35` — API error → `core.setFailed()` → job fails.
- `src/index.ts:53` — `decision === 'deny'` → `core.setFailed()` → job fails.
- **Gap:** no local signature verification; no consume call; branch protection not enforced by this action.

---

## M1 / M2 — No direct work

---

## M3 — SDK Tightening (PRIMARY)

### Update `src/index.ts`
- [ ] After `/v1/evaluate` 200 response:
  - Fetch JWKS from `${ATLASENT_URL}/.well-known/jwks.json` (use `jose`)
  - Verify Ed25519 signature of returned permit
  - On failure → `core.setFailed('permit signature invalid')`
- [ ] Call `POST /v1/permits/:id/consume` before `core.setOutput`
  - On non-200 → `core.setFailed('permit consume failed')`
- [ ] Publish outputs:
  - `permit-id` — for downstream steps
  - `decision-id` — for audit linkage
- [ ] New input `strict: true` (default) — if false, allows falling back to legacy (for staged rollout)

### Branch-protection doc
- [ ] README section: "Making this action unavoidable"
  - This action is only a true gate if set as a REQUIRED status check with "Do not allow bypassing"
  - Recommend: `CODEOWNERS` + required reviews + required `atlasent/evaluate` check + disallow admin override
  - Provide a `gh api` snippet to assert branch-protection config on install

### Optional: strict-mode guard
- [ ] Input `require-branch-protection: true` — on start, action calls GitHub API to verify the current ref's protection rules; fails if ineligible (e.g., force-push allowed). Best-effort, but makes bypass costly.

### Tests
- [ ] Replay: run same workflow twice with same SHA — second run's consume fails (409), action blocks
- [ ] Tampered signature → setFailed
- [ ] JWKS outage → setFailed (fail-closed)

---

## M4 — Deployment Convention

This action IS the CI/CD choke point for deploy workflows, but it is only unavoidable when branch protection is strict. Document pattern:
- [ ] Make the action a required status check on all release branches
- [ ] Disallow force-push and admin override on those branches
- [ ] Pair with `atlasent-control-plane`'s runtime gateway for actions that can't be gated at CI/CD time (e.g., runtime API calls)

---

## Cross-repo Dependencies

- **Depends on:** `atlasent-api` M1 (JWKS + consume)
- **Blocks:** nothing external (leaf consumer)

---

## Verification (repo-local)

- Matrix workflow that runs the action twice on the same SHA — second run must fail at `consume`
- Kill `atlasent-api` in a test run → action fails-closed (existing behavior regression-tested)

## PR Convention

`[M3] atlasent-action: verify Ed25519 + consume + branch-protection doc`
