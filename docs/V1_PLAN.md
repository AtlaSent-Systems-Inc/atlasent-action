# atlasent-action — V1 Plan

**Role:** GitHub Action that gates deploys behind an AtlaSent permit.
Drop-in CI step. Blocks merge / deploy if no permit issued.

**ICP this round:** platform engineer at a biotech who needs to prove
every production deploy was pre-authorized by a named approver — the
21 CFR Part 11 "electronic signature on production change" story.

---

## V1 gates

- [ ] Published to GitHub Marketplace under `atlasent-systems-inc/atlasent-action@v1`.
- [ ] Uses the TypeScript SDK from `atlasent-sdk` instead of raw `fetch`.
- [ ] Honors `ATLASENT_API_KEY` + `ATLASENT_ENV` inputs; fails closed
      if either is missing.
- [ ] Writes a GitHub Actions job summary with the evaluation result,
      permit token, and a link to the console's proof page.
- [ ] Test mode (`mode: advisory`) logs the decision without blocking;
      enforced mode blocks on `deny` / `hold`.
- [ ] README has a 3-line copy-paste for a production-deploy gate.
- [ ] E2E test: the action runs against a staging atlasent-api org on
      every PR.
- [ ] Tag-based release: `v1.0.0`, plus a moving `v1` major tag.
- [ ] SECURITY.md describes the threat model (action tampering via
      PR from fork, secret exfiltration via log injection).

## Sequencing

1. Swap raw `fetch` for `@atlasent/sdk`.
2. Add job-summary markdown output.
3. Wire advisory vs. enforced modes.
4. Marketplace publish (requires `uses:` compatibility testing on at
   least `ubuntu-22.04` + `ubuntu-latest`).
5. Write the README quickstart and a biotech-specific example
   (`.github/workflows/prod-release.yml`).

## Out of scope for V1

- GitLab CI, CircleCI, Jenkins adapters (separate repos).
- Dynamic approval requests inside the action (stays a pass/fail gate;
  escalation lives in the console).

## Risks

- **Secret handling.** `ATLASENT_API_KEY` in `env:` leaks to logs on
  `set -x`. Test for masking before publishing.
- **Fork PRs.** A malicious PR from a fork should not be able to
  exfiltrate `ATLASENT_API_KEY`. Use
  `pull_request_target` + no secrets, or document the right pattern
  prominently in the README.
