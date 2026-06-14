# Releasing `atlasent-action`

Customers reference the action as
`uses: AtlaSent-Systems-Inc/atlasent-action@v1`, so a published `v1` GitHub
Release must exist and the floating `v1` tag must track the latest `v1.x`.

The [`Release`](.github/workflows/release.yml) workflow builds, verifies the
committed `dist/index.js`, runs the AtlaSent release gate (dogfood), keyless-signs
the bundle with cosign, **creates the GitHub Release**, and **moves the floating
`v1` tag** to it.

## Prerequisites

- `dist/index.js` is committed and current (`npm run build` produces no diff).
  The release **fails** if it has drifted — build and commit it before tagging.
- Repo secrets: `ATLASENT_API_KEY`, `ATLASENT_BASE_URL` (for the release gate on
  non-bootstrap releases).

## One-time bootstrap publish (first `v1.3.0`)

There is a chicken-and-egg: the release gate (`uses: ./` → `production.release`)
can't be satisfied before any `v1` exists. Bootstrap once, gate-exempt:

```sh
# 1. Tag the release commit (must have a current committed dist/index.js).
git tag v1.3.0
git push origin v1.3.0

# 2. Run the Release workflow manually with the gate skipped:
gh workflow run release.yml -f ref=v1.3.0 -f bootstrap=true
```

This builds + signs, creates the `v1.3.0` GitHub Release, and points `v1` at it.
Confirm the Marketplace listing, then every customer `@v1` reference resolves to
this build (including the PR-review approvals reader).

## Steady-state releases (after bootstrap)

Just push a tag — the gate runs (dogfood), no `bootstrap` flag:

```sh
git tag v1.4.0
git push origin v1.4.0   # release.yml runs on the tag push, gate active
```

The workflow creates the `v1.4.0` Release and advances `v1` automatically.

## Correcting `v1` out of band

Use the [`Move v1 floating tag`](.github/workflows/create-v1-tag.yml) workflow
(`gh workflow run create-v1-tag.yml -f target_tag=v1.3.0`). Defaults to the
latest `v1.*.*` tag when no target is given. No hardcoded SHAs.

## Note: version vocabulary

`package.json` is currently `2.0.0` while the published tag line is `v1.x`
(matching the README and the console onboarding snippet). The git tag — not
`package.json` — is what `uses: …@v1` resolves and what the Marketplace lists, so
this does not affect resolution. Reconciling `package.json` to the `v1` line is a
separate cleanup.
