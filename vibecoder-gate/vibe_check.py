#!/usr/bin/env python3
"""Vibecoder Deploy Gate — AI-powered code vibe check via Claude."""

import json
import os
import re
import sys

import anthropic

SYSTEM_PROMPT = """\
You are the Vibecoder Deploy Gate — an AI code reviewer that decides whether a diff is safe to ship.

Evaluate the diff across four dimensions and return ONLY a single valid JSON object
(no markdown fences, no prose outside the JSON):

{
  "vibe_score": <integer 0–10, overall deploy go/no-go>,
  "scores": {
    "code_quality":     <integer 0–10>,
    "security":         <integer 0–10>,
    "test_coverage":    <integer 0–10>,
    "deploy_readiness": <integer 0–10>
  },
  "verdict": "PASS" | "FAIL",
  "summary": "<1–2 sentences>",
  "issues": [
    {"severity": "critical" | "major" | "minor", "category": "<tag>", "message": "<concise description>"}
  ],
  "recommendations": ["<actionable fix>"]
}

Scoring criteria:
  code_quality     — naming, clarity, complexity, duplication, dead code
  security         — injection, hardcoded secrets, auth bypasses, unsafe deserialization, known-vuln patterns
  test_coverage    — new logic tested?, edge cases covered?, test quality
  deploy_readiness — DB migrations handled?, env config complete?, feature-flagged?, rollback possible?
  vibe_score       — weighted: security 30% + deploy_readiness 30% + code_quality 20% + test_coverage 20%
  verdict          — PASS when vibe_score >= MIN_SCORE, FAIL otherwise

Flag real, actionable issues only. Skip stylistic nits.\
"""


def score_bar(score: int) -> str:
    return "█" * score + "░" * (10 - score) + f" {score}/10"


def build_comment(result: dict, min_score: int) -> str:
    passed = result.get("verdict") == "PASS"
    gate_icon = "✅" if passed else "🚫"
    gate_label = "PASS" if passed else "FAIL"
    scores = result.get("scores", {})

    issues_md = ""
    if result.get("issues"):
        icons = {"critical": "🔴", "major": "🟡", "minor": "🔵"}
        issues_md = "\n\n**Issues found:**\n"
        for issue in result["issues"]:
            icon = icons.get(issue.get("severity", "minor"), "⚪")
            issues_md += f"- {icon} `{issue.get('category', 'general')}` — {issue.get('message', '')}\n"

    recs_md = ""
    if result.get("recommendations"):
        recs_md = "\n\n**Recommendations:**\n"
        for rec in result["recommendations"]:
            recs_md += f"- {rec}\n"

    return (
        f"## {gate_icon} Vibecoder Deploy Gate: {gate_label}\n\n"
        f"> {result.get('summary', '')}\n\n"
        f"| Dimension | Score |\n"
        f"|-----------|-------|\n"
        f"| 🎯 **Overall Vibe** | `{score_bar(result.get('vibe_score', 0))}` |\n"
        f"| 🧹 Code Quality | `{score_bar(scores.get('code_quality', 0))}` |\n"
        f"| 🔒 Security | `{score_bar(scores.get('security', 0))}` |\n"
        f"| 🧪 Test Coverage | `{score_bar(scores.get('test_coverage', 0))}` |\n"
        f"| 🚀 Deploy Readiness | `{score_bar(scores.get('deploy_readiness', 0))}` |\n"
        f"{issues_md}{recs_md}\n"
        f"<sub>Minimum passing score: {min_score}/10 · "
        f"Powered by [AtlaSent Vibecoder Gate](https://atlasent.io)</sub>"
    )


def write_outputs(result: dict, verdict: str, vibe_score: int) -> None:
    github_output = os.environ.get("GITHUB_OUTPUT", "")
    if not github_output:
        return
    report_json = json.dumps(result)
    with open(github_output, "a") as fh:
        fh.write(f"vibe-score={vibe_score}\n")
        fh.write(f"passed={'true' if verdict == 'PASS' else 'false'}\n")
        fh.write(f"verdict={verdict}\n")
        fh.write(f"report<<VIBE_EOF\n{report_json}\nVIBE_EOF\n")


def main() -> int:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY is not set", file=sys.stderr)
        return 2

    diff_file = os.environ.get("DIFF_FILE", "pr.diff")
    try:
        with open(diff_file) as fh:
            diff = fh.read()
    except OSError as exc:
        print(f"ERROR: Cannot read diff file '{diff_file}': {exc}", file=sys.stderr)
        return 2

    min_score = int(os.environ.get("MIN_VIBE_SCORE", "6"))
    max_chars = int(os.environ.get("DIFF_MAX_CHARS", "15000"))

    if not diff.strip():
        empty_result = {
            "vibe_score": 10,
            "verdict": "PASS",
            "summary": "Empty diff — nothing to evaluate.",
            "scores": {"code_quality": 10, "security": 10, "test_coverage": 10, "deploy_readiness": 10},
            "issues": [],
            "recommendations": [],
        }
        write_outputs(empty_result, "PASS", 10)
        comment_file = os.environ.get("COMMENT_FILE", "vibe_comment.md")
        with open(comment_file, "w") as fh:
            fh.write(build_comment(empty_result, min_score))
        print("No diff content — skipping vibe check (nothing changed).")
        return 0

    if len(diff) > max_chars:
        diff = diff[:max_chars] + f"\n\n[... DIFF TRUNCATED: showing {max_chars}/{len(diff)} chars ...]"

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"MIN_SCORE: {min_score}\n\n```diff\n{diff}\n```"}],
    )

    raw = message.content[0].text.strip()

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            result = json.loads(match.group())
        else:
            print(f"ERROR: Could not parse Claude response as JSON:\n{raw}", file=sys.stderr)
            return 2

    vibe_score = result.get("vibe_score", 0)
    if result.get("verdict") not in ("PASS", "FAIL"):
        result["verdict"] = "PASS" if vibe_score >= min_score else "FAIL"

    verdict = result["verdict"]
    write_outputs(result, verdict, vibe_score)

    comment = build_comment(result, min_score)
    comment_file = os.environ.get("COMMENT_FILE", "vibe_comment.md")
    with open(comment_file, "w") as fh:
        fh.write(comment)

    print(comment)
    print(f"\nVibe check result: {verdict} ({vibe_score}/10)", flush=True)

    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
