# No-secrets scan: explainer

`explain.sh` post-processes gitleaks' JSON output into a vibecoder-friendly markdown summary that's surfaced on the GitHub Actions job summary and the PR check.

The friendly framing is the whole point: the goal isn't just to fail the build, it's to **teach the right pattern**, so the next paste from ChatGPT doesn't repeat the same mistake.

Reused by `.github/workflows/no-secrets-scan.yml` in this repo.
