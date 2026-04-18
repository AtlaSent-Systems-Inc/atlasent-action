# Keyless Authentication with OIDC

AtlaSent supports GitHub's OpenID Connect (OIDC) tokens so you never need to
store a long-lived API key as a repository secret.

## How it works

1. Your workflow requests a short-lived JWT from GitHub's OIDC provider.
2. The action sends that JWT to AtlaSent's `/v1-evaluate` endpoint as the
   `Authorization: Bearer` token.
3. AtlaSent validates the JWT signature against GitHub's public keys and
   verifies the `aud` claim matches your configured audience.
4. The evaluation proceeds using the policy bound to your GitHub OIDC subject
   (`repo:org/repo:ref:refs/heads/main`, etc.).

## Setup

### 1. Grant `id-token: write` permission

```yaml
permissions:
  id-token: write   # required for OIDC
  contents: read
```

### 2. Set `auth-mode: oidc`

```yaml
- uses: atlasent-systems-inc/atlasent-action@v1
  with:
    auth-mode: oidc
    action: deploy
    environment: production
```

No `api-key` secret needed.

### 3. Bind a policy to your OIDC subject in AtlaSent

In the AtlaSent console, go to **Settings → OIDC Bindings** and add a binding:

| Field | Value |
|-------|-------|
| Subject pattern | `repo:your-org/your-repo:ref:refs/heads/main` |
| Policy | Your production deploy policy |
| Audience | `https://atlasent.io` (default) |

Subject patterns support `*` wildcards:
- `repo:acme-corp/*:ref:refs/heads/main` — all repos, main branch only
- `repo:acme-corp/api:*` — all refs in one repo

## Comparison

| | API key mode | OIDC mode |
|---|---|---|
| Secrets stored | Yes (`ATLASENT_API_KEY`) | None |
| Key rotation | Manual | Automatic (JWT TTL ~5 min) |
| Least-privilege | Per-key scopes | Per-subject policy binding |
| Auditability | Key name in audit log | GitHub subject + workflow in audit log |
| Setup complexity | Low | Low (one console config) |
