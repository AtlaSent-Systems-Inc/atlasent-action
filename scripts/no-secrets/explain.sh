#!/usr/bin/env bash
# Post-process gitleaks JSON into a vibecoder-friendly explanation.
# Writes a Markdown summary to $GITHUB_STEP_SUMMARY (if set) and stdout.
#
# Usage: explain.sh <path-to-gitleaks-findings.json>
set -euo pipefail

findings_file="${1:-.no-secrets/findings.json}"
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ ! -s "$findings_file" ] || [ "$(cat "$findings_file")" = "null" ] || [ "$(cat "$findings_file")" = "[]" ]; then
  {
    echo "## No secrets detected"
    echo
    echo "Nothing in this change matches a known secret pattern. Nice."
  } >> "$out"
  exit 0
}

count=$(jq 'length' "$findings_file")

{
  echo "## ${count} potential secret$( [ "$count" -ne 1 ] && echo s ) detected"
  echo
  echo "The scan found values in your code that look like real credentials. **Assume each one is leaked and rotate it now** — even if you remove the line in a follow-up commit, the value has already entered git history and may have been crawled."
  echo
  echo "### What to do"
  echo
  echo "1. **Rotate the key** at the provider's dashboard (Anthropic console, OpenAI dashboard, AWS IAM, etc.)."
  echo "2. **Move the new value to \`.env\`** (which is gitignored). If \`.env.example\` doesn't list this variable yet, add it as a placeholder."
  echo "3. **Read it from the environment in code** — \`process.env.X\` (Node) or \`os.environ['X']\` (Python). Never as a string literal."
  echo "4. Commit the fix and push again."
  echo
  echo "If a finding is genuinely safe (e.g., a documented public sample value or a test fixture), add a trailing \`gitleaks:allow\` comment on that line. Use sparingly."
  echo
  echo "### Findings"
  echo
  jq -r '.[] | "- **\(.RuleID)** in `\(.File):\(.StartLine)` — \(.Description // "matched a secret pattern")"' "$findings_file"
} >> "$out"

exit 0
