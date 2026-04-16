# General GxP — AI Agent Governance

## Overview

This is a catch-all policy template for AI agent actions in any GxP-regulated environment (GMP, GLP, GCP, GDP, GPvP). Use this when your agent operates across multiple regulatory scopes, or when a more specific template (21 CFR Part 11, EU Annex 11, ICH E6) does not apply.

## What This Policy Governs

This template authorizes AI agent actions in regulated environments where general GxP principles apply, including:

- **Writing to quality management systems** (deviation reports, CAPA records, change controls)
- **Interacting with production systems** that fall under GMP but outside specific Part 11 or Annex 11 scope
- **Cross-functional agent actions** that touch multiple regulated systems
- **GLP laboratory operations** where AI agents generate or modify study data

## Key Context Fields

| Field | Purpose |
|-------|---------|
| `system_validation_status` | Confirms the target system is validated for its intended use |
| `approvals` | Number of human approvals obtained before the agent acts |
| `quality_system_scope` | Scope within the quality system (production, laboratory, warehouse, etc.) |
| `deviation_open` | Whether there is an open deviation against this system or process |
| `capa_required` | Whether a CAPA has been raised related to this action or system |
| `change_window` | Whether the action is within an approved change control window |
| `data_classification` | Classification of the data being acted on (gxp_regulated, gxp_critical, non_gxp) |

## Usage

1. Copy `policy.json` into your agent's configuration
2. Replace `YOUR_AGENT_NAME` and `YOUR_SYSTEM_NAME`
3. Set `quality_system_scope` to the area your agent operates in
4. Adjust `approvals` — even a minimum of 1 ensures human-in-the-loop
5. Set `deviation_open` and `capa_required` dynamically based on your quality system state

## Action Types

| Action Type | Description |
|-------------|-------------|
| `gxp_system.write` | Write to any GxP-regulated system |
| `gxp_system.modify` | Modify existing GxP records |
| `gxp_system.review` | Execute an automated review or check |
| `quality_event.create` | Create a deviation, CAPA, or change control |
| `quality_event.update` | Update the status of a quality event |
