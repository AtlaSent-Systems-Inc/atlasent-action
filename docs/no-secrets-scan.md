# No-secrets scan (reusable workflow)

A GitHub Actions workflow you can drop into any repo to catch committed credentials before they merge.

## Add it to a repo

```yaml
# .github/workflows/no-secrets.yml
name: no-secrets-scan

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  scan:
    uses: atlasent-systems-inc/atlasent-action/.github/workflows/no-secrets-scan.yml@main
    with:
      config-path: .gitleaks.toml   # optional, defaults to this path
```

## Inputs

| Input | Default | Notes |
|---|---|---|
| `config-path` | `.gitleaks.toml` | Path to your gitleaks config inside the caller repo. Optional. |
| `gitleaks-version` | `8.21.2` | Pin a different gitleaks version if you have to. |
| `fail-on-finding` | `true` | Set to `false` to log findings without failing the job. Not recommended outside of dry-run rollouts. |

## Behavior

- **On pull requests** — only scans the diff between the base and head SHAs. Fast and low false positive rate.
- **On push to main** — scans the full history. Catches anything that snuck through.
- **Findings** — each finding becomes a line in the job summary with a plain-language explanation and what to do next. The actual secret value is redacted in the report (we don't want to re-leak it in CI logs).

## Pair it with the starter template

The [no-secrets-starter](https://github.com/atlasent-systems-inc/atlasent-examples/tree/main/no-secrets-starter) under `atlasent-examples` ships with this workflow pre-wired, plus a pre-commit hook so leaks are caught locally too. If you're starting a new project, copy that template instead of wiring this manually.
