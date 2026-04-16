# ICH E6(R2) — Good Clinical Practice

## Regulation Overview

ICH E6(R2) is the international standard for the design, conduct, performance, monitoring, auditing, recording, analysis, and reporting of clinical trials. It ensures that trial data and reported results are credible and accurate, and that the rights, integrity, and confidentiality of trial subjects are protected. Adopted by FDA, EMA, PMDA, and other regulatory authorities worldwide.

## What This Policy Governs

This template authorizes AI agent actions that interact with clinical trial data and systems, including:

- **Writing to clinical data management systems** (EDC systems, eCRF entries, query responses)
- **Modifying trial records** subject to ICH E6(R2) source data requirements
- **Actions involving blinded data** where unblinding controls must be enforced
- **Sponsor-delegated monitoring activities** performed by AI agents

## Key Context Fields

| Field | Purpose | ICH E6(R2) Reference |
|-------|---------|---------------------|
| `system_validation_status` | Confirms the system is validated for intended use | Section 5.5.3 — Computerized systems validation |
| `approvals` | Number of human approvals before agent action | Section 5.18 — Monitoring / oversight |
| `trial_phase` | Current phase of the clinical trial | General — risk-based approach to monitoring |
| `blinding_status` | Whether trial data is blinded, unblinded, or partially blinded | Section 5.14 — Supply and handling of investigational product |
| `irb_approval_current` | Confirms IRB/IEC approval is current for this trial | Section 3.1 — IRB/IEC responsibilities |
| `informed_consent_verified` | Confirms informed consent was obtained for affected subjects | Section 4.8 — Informed consent |
| `source_data_verification` | Whether source data verification is required for this action | Section 5.18.4(c) — Source data verification |
| `sponsor_oversight` | Confirms sponsor oversight is active for this action | Section 5.2 — Adequate oversight |

## Usage

1. Copy `policy.json` into your agent's configuration
2. Replace `YOUR_AGENT_NAME` with your agent's identifier
3. Replace `YOUR_SYSTEM_NAME` with the target clinical system (e.g., EDC, CTMS, eTMF)
4. Set `trial_phase` to the current trial phase
5. Set `blinding_status` accurately — incorrect values risk unblinding violations
6. Adjust `approvals` to match your monitoring plan's requirements

## Action Types

| Action Type | Description |
|-------------|-------------|
| `clinical_data.write` | Write new clinical data to an EDC or eCRF |
| `clinical_data.modify` | Modify existing clinical trial records |
| `clinical_data.query` | Create or respond to a data query |
| `clinical_data.lock` | Lock a dataset or individual record for analysis |
| `clinical_data.monitor` | Execute sponsor-delegated monitoring review |
| `clinical_data.export` | Export clinical data for analysis or submission |
