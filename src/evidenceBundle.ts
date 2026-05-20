/**
 * Evidence bundle builder for the AtlaSent GitHub Action.
 *
 * After a successful enforce(), assemble a compliance-ready evidence
 * bundle from the decision data and emit it as GitHub Actions outputs.
 * The bundle can be uploaded as a job artifact for audit purposes.
 *
 * This module is intentionally self-contained — no workspace package
 * dependencies, only node:crypto. It mirrors the ActionEvidenceBundle
 * type from the SDK's evidenceEngine.ts so bundles from both sources
 * are structurally compatible.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface EvidenceReceiptPayload {
  receipt_id: string;
  evaluation_id: string;
  permit_id: string | null;
  audit_hash: string | null;
  issued_at: string;
  action: string;
  actor: string;
  environment: string;
  repository: string;
  sha: string;
  run_id: string;
  decision: "allow";
}

export interface EvidenceReceipt extends EvidenceReceiptPayload {
  algorithm: "hmac-sha256" | "none";
  signature: string | null;
  signing_key_id: string | null;
}

export interface ComplianceControl {
  control_id: string;
  framework: "SOC2";
  satisfied: boolean;
  evidence_type: string;
}

export interface ActionEvidenceBundle {
  v: 1;
  bundle_id: string;
  action: string;
  actor: string;
  decision: "allow";
  environment: string;
  repository: string;
  sha: string;
  run_id: string;
  run_url: string;
  receipt: EvidenceReceipt;
  compliance_controls: ComplianceControl[];
  generated_at: string;
  bundle_hash: string;
}

export interface BuildEvidenceBundleArgs {
  evaluationId: string;
  /** Permit token (already consumed by verifyPermit; stored as an ID reference). */
  permitToken: string;
  auditHash?: string | null;
  action: string;
  actor: string;
  environment: string;
  repository: string;
  sha: string;
  runId: string;
  runUrl: string;
  /** HMAC-SHA256 signing secret. Omit for unsigned receipts. */
  signingSecret?: string;
  /** Key ID paired with signingSecret for rotation tracking. */
  signingKeyId?: string;
}

// ── Crypto helpers ─────────────────────────────────────────────────────────

function genId(): string {
  return randomUUID();
}

function hmacSha256(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ── Compliance controls ────────────────────────────────────────────────────

function buildComplianceControls(hasAuditHash: boolean): ComplianceControl[] {
  return [
    {
      control_id: "CC7.2",
      framework: "SOC2",
      satisfied: true,
      evidence_type: "audit_trail",
    },
    {
      control_id: "CC8.1",
      framework: "SOC2",
      satisfied: true,
      evidence_type: "change_management_gate",
    },
    {
      control_id: "CC6.1",
      framework: "SOC2",
      satisfied: true,
      evidence_type: "logical_access_control",
    },
    {
      control_id: "CC3.2",
      framework: "SOC2",
      // CC3.2 (policy violations) requires the audit hash to be present.
      satisfied: hasAuditHash,
      evidence_type: "policy_evaluation_evidence",
    },
  ];
}

// ── Main builder ───────────────────────────────────────────────────────────

/**
 * Build a compliance-ready evidence bundle from a successful enforce()
 * result. Returns the bundle as a plain object; callers serialize to
 * JSON and emit as GitHub Actions outputs or upload as artifacts.
 *
 * The `bundle_hash` field is a SHA-256 of the entire bundle (with
 * `bundle_hash` omitted from the hash input) so tampering is detectable.
 */
export function buildEvidenceBundle(
  args: BuildEvidenceBundleArgs,
): ActionEvidenceBundle {
  const receiptId = genId();
  const bundleId = genId();
  const generatedAt = new Date().toISOString();

  // ── Receipt ───────────────────────────────────────────────────────────────
  const receiptPayload: EvidenceReceiptPayload = {
    receipt_id: receiptId,
    evaluation_id: args.evaluationId,
    permit_id: args.permitToken || null,
    audit_hash: args.auditHash ?? null,
    issued_at: generatedAt,
    action: args.action,
    actor: args.actor,
    environment: args.environment,
    repository: args.repository,
    sha: args.sha,
    run_id: args.runId,
    decision: "allow",
  };

  let signature: string | null = null;
  let algorithm: "hmac-sha256" | "none" = "none";

  if (args.signingSecret) {
    // Signing input: receipt_id + "\n" + issued_at + "\n" + JSON(payload)
    // Matches the convention in the SDK's evidenceEngine.ts so receipts
    // from both sources verify with the same offline verifier.
    const sigInput = `${receiptId}\n${generatedAt}\n${JSON.stringify(receiptPayload)}`;
    signature = hmacSha256(args.signingSecret, sigInput);
    algorithm = "hmac-sha256";
  }

  const receipt: EvidenceReceipt = {
    ...receiptPayload,
    algorithm,
    signature,
    signing_key_id: args.signingKeyId ?? null,
  };

  // ── Bundle (hash computed last) ───────────────────────────────────────────
  const hasAuditHash = Boolean(args.auditHash);
  const complianceControls = buildComplianceControls(hasAuditHash);

  const bundleBody = {
    v: 1 as const,
    bundle_id: bundleId,
    action: args.action,
    actor: args.actor,
    decision: "allow" as const,
    environment: args.environment,
    repository: args.repository,
    sha: args.sha,
    run_id: args.runId,
    run_url: args.runUrl,
    receipt,
    compliance_controls: complianceControls,
    generated_at: generatedAt,
  };

  const bundleHash = sha256Hex(JSON.stringify(bundleBody));

  return { ...bundleBody, bundle_hash: bundleHash };
}
