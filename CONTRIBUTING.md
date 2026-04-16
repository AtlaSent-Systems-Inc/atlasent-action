# Contributing to AtlaSent Policy Templates

Thank you for your interest in contributing to this repository. These templates serve compliance teams, quality assurance professionals, and IT leaders in regulated life sciences environments. Contributions that improve clarity, accuracy, or coverage are welcome.

## Who Should Contribute

- **Compliance professionals** with expertise in GxP, FDA, EMA, or ICH regulations
- **Quality assurance teams** implementing AI agent governance in validated environments
- **IT and engineering leads** integrating AtlaSent into regulated workflows

## What We Accept

### New Policy Templates

If your organization operates under a regulatory framework not yet covered (e.g., MHRA guidelines, Health Canada regulations, PMDA requirements), we welcome new template directories following the established structure.

Each new template must include:

1. **A policy JSON file** — Structured for AtlaSent's `POST /v1-evaluate` request body, with all required fields and context parameters relevant to the regulation.
2. **A README.md** — Explaining the regulation, the specific agent actions governed, and step-by-step implementation guidance.

### Improvements to Existing Templates

- Corrections to regulatory references or citations
- Additional context fields relevant to a regulation
- Clarifications to implementation guidance
- New action types within an existing regulatory scope

## Submission Process

1. **Fork this repository** and create a branch from `main`.
2. **Make your changes** following the structure and tone of existing templates.
3. **Submit a pull request** with a clear description of what you are adding or changing, and why.

## Style Guidelines

- **Tone**: Professional, compliance-first, enterprise-ready. These templates are read by Chief Compliance Officers, legal teams, and quality assurance professionals — not primarily by developers.
- **Regulatory accuracy**: All references to regulations must cite specific sections, paragraphs, or articles. Do not paraphrase regulatory requirements loosely.
- **JSON structure**: Policy files must be valid JSON and follow the established schema. Use descriptive field values that reflect real-world regulated operations.
- **No placeholder or demo data**: All example values should represent realistic regulated scenarios (e.g., `"validated_system.write"` not `"test.action"`).

## Code of Conduct

All contributors are expected to engage respectfully and professionally. Contributions are reviewed by the AtlaSent team for regulatory accuracy and structural consistency.

## Questions

For questions about contributing, policy structure, or AtlaSent integration, contact us at [atlasent.io](https://atlasent.io).
