#!/usr/bin/env bash
set -euo pipefail

# ── AtlaSent GxP Quickstart ──────────────────────────────────────────────────
# Demonstrates execution-time authorization for an AI agent action.
# No account required — uses the AtlaSent sandbox environment.
# ──────────────────────────────────────────────────────────────────────────────

ATLASENT_BASE_URL="https://sandbox.atlasent.io/functions/v1"
ATLASENT_SANDBOX_KEY="sbx_demo_key_replace_with_real_sandbox_key"

ACTION_TYPE="validated_system.write"
ACTOR_ID="agent:quickstart-demo"
REQUEST_ID="quickstart-$(date +%s)-$$"

echo ""
echo "── AtlaSent GxP Quickstart ──────────────────────────"
echo "Action:  ${ACTION_TYPE}"
echo "Actor:   ${ACTOR_ID}"
echo "Context: 21 CFR Part 11 · production · 2 approvals"
echo ""

# ── Step 1: Evaluate ─────────────────────────────────────────────────────────
# Ask AtlaSent: "Should this agent action be allowed?"

EVAL_BODY=$(jq -nc \
  --arg action_type "$ACTION_TYPE" \
  --arg actor_id "$ACTOR_ID" \
  --arg request_id "$REQUEST_ID" \
  '{
    action_type: $action_type,
    actor_id: $actor_id,
    request_id: $request_id,
    context: {
      environment: "production",
      regulation: "21-cfr-part-11",
      system_validation_status: "validated",
      approvals: 2,
      change_window: true,
      record_type: "batch_production_record",
      action_category: "write"
    }
  }')

echo "→ Evaluating..."

EVAL_RESP=$(curl -sS --max-time 30 \
  -X POST "${ATLASENT_BASE_URL}/v1-evaluate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ATLASENT_SANDBOX_KEY}" \
  -H "apikey: ${ATLASENT_SANDBOX_KEY}" \
  -d "${EVAL_BODY}")

DECISION=$(echo "$EVAL_RESP" | jq -r '.decision // "error"')
PERMIT_TOKEN=$(echo "$EVAL_RESP" | jq -r '.permit_token // .permit // "none"')

echo "  Decision: ${DECISION}"

if [ "$DECISION" != "allow" ]; then
  REASON=$(echo "$EVAL_RESP" | jq -r '.reason // .deny_reason // "no reason provided"')
  echo "  Reason:   ${REASON}"
  echo ""
  echo "✗ Action denied. This is expected behavior — AtlaSent blocked"
  echo "  an action that did not meet policy requirements."
  exit 1
fi

echo "  Permit:   ${PERMIT_TOKEN:0:24}..."
echo ""

# ── Step 2: Verify ───────────────────────────────────────────────────────────
# At execution time, confirm the permit is still valid.

VERIFY_BODY=$(jq -nc \
  --arg permit_token "$PERMIT_TOKEN" \
  --arg action_type "$ACTION_TYPE" \
  --arg actor_id "$ACTOR_ID" \
  --arg request_id "verify-${REQUEST_ID}" \
  '{
    permit_token: $permit_token,
    action_type: $action_type,
    actor_id: $actor_id,
    environment: "production",
    request_id: $request_id,
    context: {
      environment: "production",
      regulation: "21-cfr-part-11",
      system_validation_status: "validated",
      approvals: 2,
      change_window: true,
      record_type: "batch_production_record",
      action_category: "write"
    }
  }')

echo "→ Verifying permit at execution time..."

VERIFY_RESP=$(curl -sS --max-time 30 \
  -X POST "${ATLASENT_BASE_URL}/v1-verify-permit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ATLASENT_SANDBOX_KEY}" \
  -H "apikey: ${ATLASENT_SANDBOX_KEY}" \
  -d "${VERIFY_BODY}")

OUTCOME=$(echo "$VERIFY_RESP" | jq -r '.outcome // .decision // "error"')
VALID=$(echo "$VERIFY_RESP" | jq -r '.valid // "unknown"')

echo "  Outcome:  ${OUTCOME}"
echo "  Valid:    ${VALID}"
echo ""

if [ "$OUTCOME" = "allow" ]; then
  echo "✓ Agent action authorized. Audit trail recorded."
else
  REASON=$(echo "$VERIFY_RESP" | jq -r '.reason // .deny_reason // "unknown"')
  echo "✗ Permit verification failed: ${REASON}"
fi

echo "──────────────────────────────────────────────────────"
echo ""
echo "Next steps:"
echo "  • Browse starter policies:  ls policies/"
echo "  • See integration examples: ls examples/"
echo "  • Book a demo:              https://atlasent.io"
echo ""
