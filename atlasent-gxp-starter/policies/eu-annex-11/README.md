# EU GMP Annex 11 — Computerised Systems

## Regulation Overview

EU GMP Annex 11 applies to all forms of computerised systems used as part of GMP-regulated activities. It covers the entire system lifecycle from requirements through decommissioning, with emphasis on data integrity, validation, and operational controls. It is enforced across EMA member states and frequently referenced in MHRA inspections.

## What This Policy Governs

This template authorizes AI agent actions within computerised systems in GMP manufacturing and quality environments, including:

- **Writing to GMP production systems** (batch manufacturing records, environmental monitoring data, deviation reports)
- **Modifying data in validated computerised systems** subject to Annex 11 controls
- **Actions requiring data integrity assurance** — ALCOA+ principles (Attributable, Legible, Contemporaneous, Original, Accurate, Complete, Consistent, Enduring, Available)

## Key Context Fields

| Field | Purpose | Annex 11 Reference |
|-------|---------|-------------------|
| `system_validation_status` | Confirms system is validated per lifecycle approach | Section 4 — Validation |
| `approvals` | Number of human approvals before agent action | Section 2 — Personnel (responsibility of quality) |
| `data_integrity_alcoa_plus` | Confirms ALCOA+ data integrity principles are enforced | Section 7 — Data Storage / Data Integrity guidance |
| `qualified_person_oversight` | Confirms QP has oversight of this system and action | Section 2 — Personnel |
| `backup_verified` | Confirms backup and restore has been verified for this system | Section 7.2 — Data Storage |
| `supplier_qualified` | Confirms the system supplier/vendor is qualified | Section 3.3 — Suppliers and Service Providers |
| `change_window` | Whether the action falls within an approved change control window | Section 10 — Change Management |

## Usage

1. Copy `policy.json` into your agent's configuration
2. Replace `YOUR_AGENT_NAME` with your agent's identifier
3. Replace `YOUR_SYSTEM_NAME` with the target computerised system
4. Adjust `approvals` to match your quality system's requirements
5. Ensure `data_integrity_alcoa_plus` is `true` only when your system enforces ALCOA+ controls

## Action Types

| Action Type | Description |
|-------------|-------------|
| `computerised_system.write` | Write a new record to a computerised system |
| `computerised_system.modify` | Modify existing GMP data |
| `computerised_system.transfer` | Transfer data between computerised systems |
| `computerised_system.archive` | Archive or retrieve data from long-term storage |
