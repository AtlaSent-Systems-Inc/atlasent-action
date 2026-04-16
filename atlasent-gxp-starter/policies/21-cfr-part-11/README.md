# 21 CFR Part 11 — Electronic Records and Electronic Signatures

## Regulation Overview

FDA 21 CFR Part 11 establishes the criteria under which electronic records and electronic signatures are considered trustworthy, reliable, and equivalent to paper records and handwritten signatures. It applies to any FDA-regulated organization that creates, modifies, maintains, archives, retrieves, or transmits electronic records.

## What This Policy Governs

This template authorizes AI agent actions that create or modify electronic records in validated systems, including:

- **Writing to production databases** in validated environments (batch records, laboratory results, quality events)
- **Modifying electronic records** that are subject to predicate rule requirements
- **Actions requiring electronic signature binding** — ensuring the agent's action is linked to an accountable human approver

## Key Context Fields

| Field | Purpose | 21 CFR Part 11 Reference |
|-------|---------|--------------------------|
| `system_validation_status` | Confirms the target system is validated per §11.10(a) | Section 11.10(a) — System validation |
| `approvals` | Number of human approvals obtained before agent action | Section 11.10(g) — Authority checks |
| `requires_electronic_signature` | Whether this action requires signature binding | Section 11.50 — Signature manifestations |
| `signature_meaning` | The meaning associated with the signature (e.g., authorship, review, approval) | Section 11.50(b) |
| `audit_trail_enabled` | Confirms audit trail is active for this record type | Section 11.10(e) — Audit trail |
| `change_window` | Whether the action falls within an approved change control window | Section 11.10(k)(2) — Change control |

## Usage

1. Copy `policy.json` into your agent's configuration
2. Replace `YOUR_AGENT_NAME` with your agent's identifier
3. Replace `YOUR_SYSTEM_NAME` with the target validated system
4. Adjust `approvals` to match your SOP's minimum approval threshold
5. Set `signature_meaning` to the appropriate value for the action type

## Action Types

Customize `action_type` based on what the agent does:

| Action Type | Description |
|-------------|-------------|
| `validated_system.write` | Write a new record to a validated system |
| `validated_system.modify` | Modify an existing electronic record |
| `validated_system.delete` | Delete or deactivate an electronic record |
| `validated_system.export` | Export records from a validated system |
| `electronic_signature.apply` | Apply an electronic signature to a record |
