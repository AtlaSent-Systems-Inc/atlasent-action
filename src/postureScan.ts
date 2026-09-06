// AtlaSent Posture Scan — advisory GitHub security-posture reporting.
//
// Reports on the CALLING repo's own GitHub security hygiene (branch
// protection, CODEOWNERS, Dependabot, CodeQL, secret scanning, org 2FA
// enforcement) using only the `GITHUB_TOKEN` already available in any
// GitHub Actions run, plus the checked-out working tree.
//
// Hard scope constraint (founder directive, 2026-09): every signal here
// must be something DIRECTLY, VERIFIABLY observable via the GitHub API or
// local filesystem with the token's ACTUAL permissions — no inference, no
// risk scoring, no synthetic findings. When a signal cannot be observed
// (insufficient token permission, or a signal that is structurally
// unreadable by any repository-scoped token), the finding is reported as
// `status: "unknown"` with an honest, specific `reason` — never guessed,
// never silently omitted, never substituted with a proxy presented as if
// it answered the real question.
//
// Findings are strictly advisory: this module never gates, never fails
// the step by itself, and produces no risk score. It follows the exact
// shape (evaluations/findings/step-summary) established by
// governanceAgents.ts and never touches the AtlaSent API at all — it is
// pure GitHub-facing signal, so it needs no ATLASENT_API_KEY.
//
// Empirically verified permission requirements (2026-09, against a live
// GitHub App installation token restricted to this org's repos — the same
// permission model a workflow's default GITHUB_TOKEN follows — cross-
// checked against GitHub's own published workflow-permissions JSON schema
// and REST OpenAPI spec, not assumed):
//
//   OBSERVABLE with plain `contents: read`, PROVIDED the repo was actually
//   checked out (e.g. via `actions/checkout`) before this step runs — if
//   not, these report "unknown"/workspace_not_checked_out rather than
//   guessing "absent":
//     - CODEOWNERS file presence                 (local fs)
//     - .github/dependabot.yml presence           (local fs)
//     - A `uses: github/codeql-action/...` step   (local fs; NOT a bare
//       "codeql" text match — that produced false positives on comments,
//       job names, and unrelated mentions of the word)
//
//   OBSERVABLE ONLY WITH A DIFFERENT, MORE-PRIVILEGED CREDENTIAL THAN THE
//   DEFAULT GITHUB_TOKEN — and NOT fixable by editing the calling workflow's
//   `permissions:` block. Verified against GitHub's own workflow-syntax
//   JSON schema: `administration` is not one of the grantable `permissions:`
//   keys at all (the valid set is actions, artifact-metadata, attestations,
//   checks, code-quality, contents, deployments, discussions, id-token,
//   issues, models, packages, pages, pull-requests, repository-projects,
//   security-events, statuses, vulnerability-alerts, copilot-requests) — so
//   the default Actions GITHUB_TOKEN can NEVER hold repository
//   Administration rights, no matter what a workflow requests. Without it,
//   every call below returns HTTP 403
//   `{"message":"Resource not accessible by integration"}` — confirmed
//   against the live GitHub REST API. To observe these, supply a
//   differently-scoped credential (a fine-grained PAT or GitHub App
//   installation token with Administration access) via the
//   `posture-scan-token` input:
//     - Branch protection rules/settings   GET /repos/{o}/{r}/branches/{b}/protection
//     - Required-status-checks config      (same protection payload)
//     - Secret scanning / push-protection status — a DIFFERENT failure
//       shape: GET /repos/{o}/{r} still returns 200, but the
//       `security_and_analysis` key is silently ABSENT from the JSON body
//       (no error at all) unless the token has admin-level access —
//       confirmed live. Absence of the key must never be read as "disabled".
//     - Dependabot alerts enabled/disabled  GET /repos/{o}/{r}/vulnerability-alerts
//       (a DIFFERENT signal from dependabot CONFIG file presence above —
//       this is "are alerts turned on", not "does a config file exist".
//       GitHub also 404s this endpoint when the repo itself isn't visible
//       to the credential, so a 404 is only read as "disabled" once this
//       module has independently confirmed via GET /repos/{o}/{r} that the
//       same credential can see the repository at all — otherwise it's
//       reported unknown, never guessed disabled)
//
//   NOT OBSERVABLE BY ANY REPOSITORY-SCOPED TOKEN, REGARDLESS OF CREDENTIAL:
//     - Org-level 2FA enforcement   GET /orgs/{org}'s
//       `two_factor_requirement_enabled` — requires an org-admin-scoped
//       credential; a repository installation token cannot see it under any
//       workflow-declared permission.
//     - Org-level SSO/SAML enforcement — reported as its OWN finding,
//       independent of the 2FA one above (an org can require 2FA without
//       enforcing SSO, or vice versa — never inferred from one to the
//       other). Confirmed against GitHub's published REST OpenAPI spec:
//       there is no SSO/SAML field or endpoint anywhere in the public REST
//       API at all. It exists only in the Enterprise GraphQL API's
//       `samlIdentityProvider` field, gated on enterprise-owner-level
//       credentials — so this is always reported not_observable_by_repo_token.

import * as fs from "node:fs";
import * as path from "node:path";

export type PostureStatus = "present" | "absent" | "unknown" | "not_applicable";

export type PostureReason =
  /** A real result was obtained; `status` reflects it directly. */
  | "observed"
  /** No GITHUB_TOKEN was supplied at all — nothing could be attempted. */
  | "no_token"
  /**
   * The token lacks access this check requires. IMPORTANT: this is NOT
   * always fixable by editing the calling workflow's `permissions:` block —
   * verified against GitHub's own workflow-syntax schema, `administration`
   * is not a grantable `permissions:` key at all (the default Actions
   * GITHUB_TOKEN can never hold repository Administration rights, no matter
   * what a workflow requests). Where that applies, the detail text points
   * callers at supplying a differently-scoped credential (a fine-grained
   * PAT or GitHub App installation token that actually has the needed
   * repository permission) via the `posture-scan-token` input instead.
   */
  | "insufficient_permission"
  /**
   * Structurally unreadable by a repository-scoped token no matter what
   * credential is supplied — either an org/enterprise-level setting outside
   * any repository permission's reach, or (confirmed against GitHub's
   * public REST OpenAPI spec) a fact with no REST representation at all.
   */
  | "not_observable_by_repo_token"
  /** The underlying concept does not apply here (e.g. org-only setting on a user-owned repo). */
  | "not_applicable"
  /**
   * The checked-out working tree has no `.git` directory — this step
   * likely ran without a preceding `actions/checkout`, so a file genuinely
   * being absent cannot be distinguished from "there was nothing to check".
   * Filesystem-based signals report this instead of guessing "absent".
   */
  | "workspace_not_checked_out"
  /** An unexpected error (network failure, malformed response) — genuinely inconclusive. */
  | "check_failed";

export interface PostureFinding {
  /** Stable machine id, e.g. "branch_protection". */
  id: string;
  /** Human label for step-summary / table rendering. */
  label: string;
  /** True only when a definite present/absent result was obtained. */
  observable: boolean;
  status: PostureStatus;
  reason: PostureReason;
  /** Human-readable explanation, including what permission would unlock this if applicable. */
  detail: string;
  /** Supporting facts backing the finding — real data, never fabricated. */
  evidence?: Record<string, unknown>;
}

export interface PostureScanResult {
  findings: PostureFinding[];
  /** present_count + absent_count — signals with a genuine observed result. */
  observed_count: number;
  /** Findings with status "unknown" specifically — NOT "not_applicable" (see not_applicable_count). */
  not_observable_count: number;
  present_count: number;
  absent_count: number;
  /** Findings with status "not_applicable" — a distinct bucket from "unknown"; the concept doesn't apply here at all. */
  not_applicable_count: number;
}

type Fs = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf-8") => string;
  readdirSync: (p: string) => string[];
};

export interface PostureScanOptions {
  /** "owner/repo". */
  repository?: string;
  /** GITHUB_TOKEN (or a caller-supplied differently-scoped token). */
  token?: string;
  /** GITHUB_API_URL. Defaults to https://api.github.com. */
  apiBase?: string;
  /** Workspace root for the checked-out repo. Defaults to GITHUB_WORKSPACE or cwd. */
  workspace?: string;
  /** Injectable fetch (test seam). */
  fetchImpl?: typeof fetch;
  /** Injectable filesystem (test seam). */
  fileSystem?: Fs;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function defaultFs(): Fs {
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    readdirSync: (p) => fs.readdirSync(p),
  };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ─── filesystem-based signals (always observable — no token needed) ───────
//
// "Observable" here still means the caller must have actually checked out
// the repository (e.g. via `actions/checkout`) before this step runs. If
// no checkout happened, `GITHUB_WORKSPACE` is an empty/irrelevant directory
// and every file-existence check would silently read as "absent" even when
// the real repository has every one of these files — a guess dressed up as
// a fact. `.git` is used as the "a checkout actually happened" marker: it
// is present after any real `actions/checkout` (including shallow/sparse
// checkouts) and absent when this step is the first one in a job with none.

function isWorkspaceCheckedOut(workspace: string, fs_: Fs): boolean {
  return fs_.existsSync(path.resolve(workspace, ".git"));
}

function notCheckedOutFinding(id: string, label: string): PostureFinding {
  return {
    id,
    label,
    observable: false,
    status: "unknown",
    reason: "workspace_not_checked_out",
    detail:
      "No .git directory found under the workspace — this step likely ran without a " +
      "preceding `actions/checkout`, so a file genuinely being absent from the real " +
      "repository cannot be distinguished from there being no checkout to look at. " +
      "Add an `actions/checkout` step before posture-scan to make this observable.",
  };
}

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const DEPENDABOT_CONFIG_PATHS = [".github/dependabot.yml", ".github/dependabot.yaml"];

function checkCodeowners(workspace: string, fs_: Fs): PostureFinding {
  const found = CODEOWNERS_PATHS.find((p) => fs_.existsSync(path.resolve(workspace, p)));
  if (!found && !isWorkspaceCheckedOut(workspace, fs_)) {
    return notCheckedOutFinding("codeowners", "CODEOWNERS file");
  }
  return {
    id: "codeowners",
    label: "CODEOWNERS file",
    observable: true,
    status: found ? "present" : "absent",
    reason: "observed",
    detail: found
      ? `Found at ${found}.`
      : `None of the standard locations exist: ${CODEOWNERS_PATHS.join(", ")}.`,
    evidence: { checked_paths: CODEOWNERS_PATHS, found_path: found ?? null },
  };
}

function checkDependabotConfig(workspace: string, fs_: Fs): PostureFinding {
  const found = DEPENDABOT_CONFIG_PATHS.find((p) => fs_.existsSync(path.resolve(workspace, p)));
  if (!found && !isWorkspaceCheckedOut(workspace, fs_)) {
    return notCheckedOutFinding("dependabot_config", "Dependabot config file");
  }
  return {
    id: "dependabot_config",
    label: "Dependabot config file",
    observable: true,
    status: found ? "present" : "absent",
    reason: "observed",
    detail: found
      ? `Found at ${found}.`
      : `Neither ${DEPENDABOT_CONFIG_PATHS.join(" nor ")} exists in the checked-out tree.`,
    evidence: { checked_paths: DEPENDABOT_CONFIG_PATHS, found_path: found ?? null },
  };
}

// Restricted to an actual `uses:` step reference to the CodeQL Action, not a
// bare word match — a bare `\bcodeql\b` match previously fired on comments,
// job/step names, or unrelated text mentioning "codeql" anywhere in a
// workflow file, producing a false "present" finding.
const CODEQL_USES_MARKER = /\buses:\s*["']?github\/codeql-action\//i;

function checkCodeqlWorkflow(workspace: string, fs_: Fs): PostureFinding {
  const checkedOut = isWorkspaceCheckedOut(workspace, fs_);
  const workflowsDir = path.resolve(workspace, ".github/workflows");
  if (!fs_.existsSync(workflowsDir)) {
    if (!checkedOut) {
      return notCheckedOutFinding("codeql_workflow", "CodeQL / code-scanning workflow");
    }
    return {
      id: "codeql_workflow",
      label: "CodeQL / code-scanning workflow",
      observable: true,
      status: "absent",
      reason: "observed",
      detail: "No .github/workflows directory in the checked-out tree.",
      evidence: { workflows_dir_exists: false },
    };
  }

  let entries: string[];
  try {
    entries = fs_.readdirSync(workflowsDir);
  } catch {
    entries = [];
  }
  const workflowFiles = entries.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const matches: string[] = [];
  for (const file of workflowFiles) {
    let content: string;
    try {
      content = fs_.readFileSync(path.join(workflowsDir, file), "utf-8");
    } catch {
      continue;
    }
    if (CODEQL_USES_MARKER.test(content)) {
      matches.push(file);
    }
  }

  return {
    id: "codeql_workflow",
    label: "CodeQL / code-scanning workflow",
    observable: true,
    status: matches.length > 0 ? "present" : "absent",
    reason: "observed",
    detail:
      matches.length > 0
        ? `A "uses: github/codeql-action/..." step found in: ${matches.join(", ")}.`
        : `Scanned ${workflowFiles.length} workflow file(s) in .github/workflows — none reference a github/codeql-action step.`,
    evidence: { workflow_files_scanned: workflowFiles, matched_files: matches },
  };
}

// ─── GitHub API–based signals ───────────────────────────────────────────────

interface RepoInfo {
  default_branch?: string;
  owner?: { type?: string };
  security_and_analysis?: {
    secret_scanning?: { status?: string };
    secret_scanning_push_protection?: { status?: string };
    dependabot_security_updates?: { status?: string };
  };
}

async function fetchRepoInfo(args: {
  repository: string;
  token: string;
  apiBase: string;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true; data: RepoInfo } | { ok: false; status: number; message: string }> {
  const url = `${args.apiBase}/repos/${args.repository}`;
  try {
    const res = await args.fetchImpl(url, { headers: ghHeaders(args.token) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, message: text.slice(0, 300) };
    }
    return { ok: true, data: (await res.json()) as RepoInfo };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
  }
}

interface BranchProtection {
  required_status_checks?: { strict?: boolean; contexts?: string[] } | null;
  enforce_admins?: { enabled?: boolean };
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    require_code_owner_reviews?: boolean;
    dismiss_stale_reviews?: boolean;
  } | null;
  allow_force_pushes?: { enabled?: boolean };
}

type ProtectionOutcome =
  | { kind: "protected"; data: BranchProtection }
  | { kind: "unprotected" }
  | { kind: "insufficient_permission"; message: string }
  | { kind: "check_failed"; message: string };

async function fetchBranchProtection(args: {
  repository: string;
  branch: string;
  token: string;
  apiBase: string;
  fetchImpl: typeof fetch;
}): Promise<ProtectionOutcome> {
  const url = `${args.apiBase}/repos/${args.repository}/branches/${encodeURIComponent(args.branch)}/protection`;
  let res: Response;
  try {
    res = await args.fetchImpl(url, { headers: ghHeaders(args.token) });
  } catch (err) {
    return { kind: "check_failed", message: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 200) {
    try {
      return { kind: "protected", data: (await res.json()) as BranchProtection };
    } catch (err) {
      return { kind: "check_failed", message: `malformed protection body: ${String(err)}` };
    }
  }
  if (res.status === 403) {
    const text = await res.text().catch(() => "");
    return { kind: "insufficient_permission", message: text.slice(0, 300) };
  }
  if (res.status === 404) {
    const text = await res.text().catch(() => "");
    // GitHub returns a DIFFERENT 404 body when the branch itself doesn't
    // exist vs. when it exists but has no protection configured. Only the
    // latter is a genuine "absent" result — never guess on the former.
    if (/not protected/i.test(text)) {
      return { kind: "unprotected" };
    }
    return { kind: "check_failed", message: text.slice(0, 300) || "404 (ambiguous — branch not found?)" };
  }
  const text = await res.text().catch(() => "");
  return { kind: "check_failed", message: `HTTP ${res.status}: ${text.slice(0, 300)}` };
}

function branchProtectionFindings(
  branch: string,
  outcome: ProtectionOutcome,
): [PostureFinding, PostureFinding] {
  if (outcome.kind === "protected") {
    const rsc = outcome.data.required_status_checks ?? null;
    const prr = outcome.data.required_pull_request_reviews ?? null;
    const branchProtection: PostureFinding = {
      id: "branch_protection",
      label: `Branch protection (${branch})`,
      observable: true,
      status: "present",
      reason: "observed",
      detail: `Branch protection is enabled on "${branch}".`,
      evidence: {
        branch,
        enforce_admins: outcome.data.enforce_admins?.enabled ?? null,
        required_approving_review_count: prr?.required_approving_review_count ?? null,
        require_code_owner_reviews: prr?.require_code_owner_reviews ?? null,
        dismiss_stale_reviews: prr?.dismiss_stale_reviews ?? null,
        allow_force_pushes: outcome.data.allow_force_pushes?.enabled ?? null,
      },
    };
    const requiredChecks: PostureFinding = {
      id: "required_status_checks",
      label: `Required status checks (${branch})`,
      observable: true,
      status: rsc ? "present" : "absent",
      reason: "observed",
      detail: rsc
        ? `Required status checks configured (strict=${rsc.strict ?? false}, contexts=${(rsc.contexts ?? []).length}).`
        : `Branch protection is enabled on "${branch}" but no required status checks are configured.`,
      evidence: rsc ? { branch, strict: rsc.strict ?? null, contexts: rsc.contexts ?? [] } : { branch },
    };
    return [branchProtection, requiredChecks];
  }

  if (outcome.kind === "unprotected") {
    const detail = `Branch "${branch}" has no protection rules configured.`;
    return [
      {
        id: "branch_protection",
        label: `Branch protection (${branch})`,
        observable: true,
        status: "absent",
        reason: "observed",
        detail,
        evidence: { branch },
      },
      {
        id: "required_status_checks",
        label: `Required status checks (${branch})`,
        observable: true,
        status: "absent",
        reason: "observed",
        detail: `No branch protection on "${branch}", so no required status checks either.`,
        evidence: { branch },
      },
    ];
  }

  if (outcome.kind === "insufficient_permission") {
    const detail =
      `Reading branch protection for "${branch}" requires the "Administration" ` +
      `repository permission on the credential used — the default Actions ` +
      `GITHUB_TOKEN can NEVER hold this permission (verified against GitHub's own ` +
      `workflow permissions schema: "administration" is not a grantable ` +
      `\`permissions:\` key at all, so adding it to the workflow YAML would not help ` +
      `and would in fact make the workflow invalid). To observe this signal, pass a ` +
      `fine-grained PAT or GitHub App installation token that actually has ` +
      `Administration: Read access via the \`posture-scan-token\` input. GitHub responded: ${outcome.message}`;
    return [
      {
        id: "branch_protection",
        label: `Branch protection (${branch})`,
        observable: false,
        status: "unknown",
        reason: "insufficient_permission",
        detail,
        evidence: { branch },
      },
      {
        id: "required_status_checks",
        label: `Required status checks (${branch})`,
        observable: false,
        status: "unknown",
        reason: "insufficient_permission",
        detail: `Same "Administration" permission gap as branch_protection blocks this signal too.`,
        evidence: { branch },
      },
    ];
  }

  // check_failed
  const detail = `Could not determine branch protection for "${branch}": ${outcome.message}`;
  return [
    {
      id: "branch_protection",
      label: `Branch protection (${branch})`,
      observable: false,
      status: "unknown",
      reason: "check_failed",
      detail,
      evidence: { branch },
    },
    {
      id: "required_status_checks",
      label: `Required status checks (${branch})`,
      observable: false,
      status: "unknown",
      reason: "check_failed",
      detail: "Branch protection check failed, so required-status-checks could not be derived either.",
      evidence: { branch },
    },
  ];
}

function secretScanningFindings(repoInfoResult: Awaited<ReturnType<typeof fetchRepoInfo>>): PostureFinding[] {
  const ids: Array<{ id: string; label: string; key: "secret_scanning" | "secret_scanning_push_protection" | "dependabot_security_updates" }> = [
    { id: "secret_scanning", label: "Secret scanning", key: "secret_scanning" },
    { id: "secret_scanning_push_protection", label: "Secret scanning push protection", key: "secret_scanning_push_protection" },
    { id: "dependabot_security_updates", label: "Dependabot security updates", key: "dependabot_security_updates" },
  ];

  if (!repoInfoResult.ok) {
    return ids.map(({ id, label }) => ({
      id,
      label,
      observable: false,
      status: "unknown",
      reason: repoInfoResult.status === 403 ? "insufficient_permission" : "check_failed",
      detail: `GET /repos/{owner}/{repo} failed (HTTP ${repoInfoResult.status || "network error"}): ${repoInfoResult.message}`,
    }));
  }

  const sa = repoInfoResult.data.security_and_analysis;
  if (sa === undefined) {
    // Empirically confirmed: GitHub returns 200 for the repo GET itself but
    // SILENTLY OMITS the `security_and_analysis` key entirely unless the
    // token has admin-level access to the repository. This is not an error
    // response — there is nothing to catch. Absence of the key must never
    // be read as "these features are disabled".
    return ids.map(({ id, label }) => ({
      id,
      label,
      observable: false,
      status: "unknown",
      reason: "insufficient_permission",
      detail:
        "GET /repos/{owner}/{repo} succeeded, but the `security_and_analysis` field was " +
        "not present in the response. GitHub only includes this field for callers with " +
        "admin-level access to the repository; a default-permission GITHUB_TOKEN cannot " +
        "see it under any `permissions:` grant available to a workflow (there is no such " +
        "grant for repository administration access). Its absence is NOT evidence that " +
        "these features are disabled. Pass a token with admin-level repo access via the " +
        "`posture-scan-token` input to observe this signal.",
    }));
  }

  return ids.map(({ id, label, key }) => {
    const status = sa[key]?.status;
    return {
      id,
      label,
      observable: status !== undefined,
      status: status === "enabled" ? "present" : status === "disabled" ? "absent" : "unknown",
      reason: status !== undefined ? "observed" : "check_failed",
      detail:
        status !== undefined
          ? `Reported status: "${status}".`
          : `\`security_and_analysis.${key}\` was present but carried no recognizable status.`,
      evidence: { raw_status: status ?? null },
    };
  });
}

async function fetchDependabotAlertsFinding(args: {
  repository: string;
  token: string;
  apiBase: string;
  fetchImpl: typeof fetch;
  /**
   * Whether this SAME credential was already independently confirmed to see
   * this repository at all, via a prior GET /repos/{owner}/{repo} call. A
   * 404 on vulnerability-alerts genuinely means "disabled" only once basic
   * repository visibility is established — GitHub also 404s this endpoint
   * when the repository is invisible to the credential (wrong/expired/
   * misscoped token), which must never be silently read as "disabled".
   */
  repoAccessible: boolean;
}): Promise<PostureFinding> {
  const url = `${args.apiBase}/repos/${args.repository}/vulnerability-alerts`;
  const id = "dependabot_alerts_enabled";
  const label = "Dependabot alerts enabled";
  let res: Response;
  try {
    res = await args.fetchImpl(url, { headers: ghHeaders(args.token) });
  } catch (err) {
    return {
      id,
      label,
      observable: false,
      status: "unknown",
      reason: "check_failed",
      detail: `Network error checking vulnerability-alerts: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.status === 204) {
    return { id, label, observable: true, status: "present", reason: "observed", detail: "Dependabot alerts are enabled for this repository." };
  }
  if (res.status === 404) {
    if (!args.repoAccessible) {
      return {
        id,
        label,
        observable: false,
        status: "unknown",
        reason: "check_failed",
        detail:
          "GET /repos/{owner}/{repo}/vulnerability-alerts returned 404, but this same " +
          "credential's GET /repos/{owner}/{repo} call did not succeed either — GitHub " +
          "also returns 404 here when the repository itself is not visible to the " +
          "credential (expired, misscoped, or wrong token), so this cannot be safely " +
          "read as \"alerts disabled\" without independently confirmed repository access.",
      };
    }
    return {
      id,
      label,
      observable: true,
      status: "absent",
      reason: "observed",
      detail:
        "Dependabot alerts are disabled for this repository (repository visibility with " +
        "this credential was independently confirmed via GET /repos/{owner}/{repo}).",
    };
  }
  if (res.status === 403) {
    const text = await res.text().catch(() => "");
    return {
      id,
      label,
      observable: false,
      status: "unknown",
      reason: "insufficient_permission",
      detail:
        `Checking whether Dependabot alerts are enabled requires elevated read access this ` +
        `token does not have (GitHub responded 403: ${text.slice(0, 200)}). Distinct from the ` +
        `dependabot_config signal, which only checks for a config FILE, not this setting.`,
    };
  }
  const text = await res.text().catch(() => "");
  return {
    id,
    label,
    observable: false,
    status: "unknown",
    reason: "check_failed",
    detail: `Unexpected HTTP ${res.status} checking vulnerability-alerts: ${text.slice(0, 200)}`,
  };
}

// 2FA and SSO enforcement are TWO INDEPENDENT org settings — an org can
// require 2FA without enforcing SAML SSO, or vice versa. A prior version of
// this module reported a single combined "org_2fa_sso_enforcement" finding
// derived only from the 2FA field, which meant a real "2FA required, SSO
// not enforced" org would show as "present" for a claim about SSO it never
// actually checked. They are now reported as two separate findings, each
// independently verified (or, for SSO, independently confirmed as having
// no REST representation at all — never inferred from the 2FA result).
async function fetchOrg2faAndSsoFindings(args: {
  repository: string;
  ownerType: string | undefined;
  token: string;
  apiBase: string;
  fetchImpl: typeof fetch;
}): Promise<[PostureFinding, PostureFinding]> {
  const twoFaId = "org_2fa_enforcement";
  const twoFaLabel = "Org-level 2FA enforcement";
  const ssoId = "org_sso_enforcement";
  const ssoLabel = "Org-level SSO enforcement";
  const owner = args.repository.split("/")[0] ?? "";

  // SSO/SAML enforcement has NO representation anywhere in GitHub's public
  // REST API (confirmed against the published REST OpenAPI spec — no path
  // or org-schema field mentions SSO/SAML at all). It is only queryable via
  // the Enterprise GraphQL API's `samlIdentityProvider` field, which
  // requires enterprise-owner-level credentials entirely outside any
  // repository or org-admin REST permission. This is therefore ALWAYS
  // not_observable_by_repo_token — never attempted as a guess, and never
  // derived from the 2FA result above.
  const ssoFinding: PostureFinding = {
    id: ssoId,
    label: ssoLabel,
    observable: false,
    status: args.ownerType === "User" ? "not_applicable" : "unknown",
    reason: args.ownerType === "User" ? "not_applicable" : "not_observable_by_repo_token",
    detail:
      args.ownerType === "User"
        ? `"${owner}" is a user account, not an organization — org-level SSO enforcement does not apply.`
        : "GitHub does not expose organization SAML SSO enforcement anywhere in the REST " +
          "API (confirmed against GitHub's own published REST OpenAPI spec). It is only " +
          "queryable via the Enterprise GraphQL API's samlIdentityProvider field with " +
          "enterprise-owner-level credentials — independent of, and never inferred from, " +
          "the org_2fa_enforcement finding above.",
  };

  if (args.ownerType === "User") {
    return [
      {
        id: twoFaId,
        label: twoFaLabel,
        observable: false,
        status: "not_applicable",
        reason: "not_applicable",
        detail: `"${owner}" is a user account, not an organization — org-level 2FA enforcement does not apply.`,
      },
      ssoFinding,
    ];
  }

  const url = `${args.apiBase}/orgs/${encodeURIComponent(owner)}`;
  let res: Response;
  try {
    res = await args.fetchImpl(url, { headers: ghHeaders(args.token) });
  } catch (err) {
    return [
      {
        id: twoFaId,
        label: twoFaLabel,
        observable: false,
        status: "unknown",
        reason: "check_failed",
        detail: `Network error checking org settings: ${err instanceof Error ? err.message : String(err)}`,
      },
      ssoFinding,
    ];
  }
  if (res.ok) {
    let data: { two_factor_requirement_enabled?: boolean } = {};
    try {
      data = (await res.json()) as { two_factor_requirement_enabled?: boolean };
    } catch {
      // fall through to the not-present branch below
    }
    if (typeof data.two_factor_requirement_enabled === "boolean") {
      return [
        {
          id: twoFaId,
          label: twoFaLabel,
          observable: true,
          status: data.two_factor_requirement_enabled ? "present" : "absent",
          reason: "observed",
          detail: `Org 2FA requirement is ${data.two_factor_requirement_enabled ? "enabled" : "not enabled"}.`,
        },
        ssoFinding,
      ];
    }
    return [
      {
        id: twoFaId,
        label: twoFaLabel,
        observable: false,
        status: "unknown",
        reason: "not_observable_by_repo_token",
        detail:
          "GET /orgs/{org} succeeded but did not include `two_factor_requirement_enabled` — " +
          "this field is only returned to an org-admin-scoped credential, which a repository-" +
          "scoped GITHUB_TOKEN can never be, regardless of workflow `permissions:` settings.",
      },
      ssoFinding,
    ];
  }

  const text = await res.text().catch(() => "");
  return [
    {
      id: twoFaId,
      label: twoFaLabel,
      observable: false,
      status: "unknown",
      reason: "not_observable_by_repo_token",
      detail:
        `Org-level settings are not observable by a repository-scoped GITHUB_TOKEN under any ` +
        `\`permissions:\` grant a workflow can request — this is a GitHub platform limitation, ` +
        `not a configuration gap this workflow can close. GitHub responded HTTP ${res.status}: ` +
        `${text.slice(0, 200)}`,
    },
    ssoFinding,
  ];
}

// ─── public entry ───────────────────────────────────────────────────────────

export async function runPostureScan(opts: PostureScanOptions): Promise<PostureScanResult> {
  const fs_ = opts.fileSystem ?? defaultFs();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const warn = opts.warn ?? (() => {});
  const workspace = opts.workspace ?? process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const repository = opts.repository?.trim();
  const token = opts.token?.trim();

  const findings: PostureFinding[] = [];

  // ── Filesystem signals — always observable, no token required ──────────
  findings.push(checkCodeowners(workspace, fs_));
  findings.push(checkDependabotConfig(workspace, fs_));
  findings.push(checkCodeqlWorkflow(workspace, fs_));

  // ── API signals — need both a repository and a token ────────────────────
  const apiSignalIds = [
    "branch_protection",
    "required_status_checks",
    "secret_scanning",
    "secret_scanning_push_protection",
    "dependabot_security_updates",
    "dependabot_alerts_enabled",
    "org_2fa_enforcement",
    "org_sso_enforcement",
  ];

  if (!repository) {
    warn("AtlaSent Posture Scan: GITHUB_REPOSITORY not set — API-based signals cannot be checked.");
    for (const id of apiSignalIds) {
      findings.push({
        id,
        label: id,
        observable: false,
        status: "unknown",
        reason: "check_failed",
        detail: "GITHUB_REPOSITORY was not set — no repository to query.",
      });
    }
    return summarize(findings);
  }

  if (!token) {
    warn(
      "AtlaSent Posture Scan: no GITHUB_TOKEN supplied — API-based signals cannot be checked. " +
        "Pass `env: GITHUB_TOKEN: ${{ github.token }}` to observe them.",
    );
    for (const id of apiSignalIds) {
      findings.push({
        id,
        label: id,
        observable: false,
        status: "unknown",
        reason: "no_token",
        detail: "No GITHUB_TOKEN was supplied to this step.",
      });
    }
    return summarize(findings);
  }

  const repoInfoResult = await fetchRepoInfo({ repository, token, apiBase, fetchImpl });
  const defaultBranch = repoInfoResult.ok ? repoInfoResult.data.default_branch ?? "main" : "main";

  const protectionOutcome = await fetchBranchProtection({
    repository,
    branch: defaultBranch,
    token,
    apiBase,
    fetchImpl,
  });
  findings.push(...branchProtectionFindings(defaultBranch, protectionOutcome));

  findings.push(...secretScanningFindings(repoInfoResult));

  findings.push(
    await fetchDependabotAlertsFinding({
      repository,
      token,
      apiBase,
      fetchImpl,
      repoAccessible: repoInfoResult.ok,
    }),
  );

  findings.push(
    ...(await fetchOrg2faAndSsoFindings({
      repository,
      ownerType: repoInfoResult.ok ? repoInfoResult.data.owner?.type : undefined,
      token,
      apiBase,
      fetchImpl,
    })),
  );

  return summarize(findings);
}

function summarize(findings: PostureFinding[]): PostureScanResult {
  let observed = 0;
  let notObservable = 0;
  let present = 0;
  let absent = 0;
  let notApplicable = 0;
  for (const f of findings) {
    if (f.status === "present" || f.status === "absent") observed++;
    else if (f.status === "unknown") notObservable++;
    else if (f.status === "not_applicable") notApplicable++;
    if (f.status === "present") present++;
    if (f.status === "absent") absent++;
  }
  return {
    findings,
    observed_count: observed,
    not_observable_count: notObservable,
    not_applicable_count: notApplicable,
    present_count: present,
    absent_count: absent,
  };
}

// ─── step summary rendering ─────────────────────────────────────────────────

const STATUS_ICON: Record<PostureStatus, string> = {
  present: "✅",
  absent: "⚠️",
  unknown: "❓",
  not_applicable: "➖",
};

export function renderPostureStepSummary(result: PostureScanResult): string {
  const lines: string[] = [];
  lines.push("## AtlaSent Posture Scan — GitHub security posture");
  lines.push("");
  lines.push(
    "> Advisory only. Every row is either a directly observed signal or an honestly " +
      "reported `unknown` — never a guess, never a synthetic score. This mode gates nothing.",
  );
  lines.push("");
  lines.push("| Signal | Status | Reason | Detail |");
  lines.push("|---|---|---|---|");
  for (const f of result.findings) {
    const detail = f.detail.replace(/\|/g, "\\|").replace(/\n+/g, " ");
    lines.push(`| ${f.label} | ${STATUS_ICON[f.status]} ${f.status} | \`${f.reason}\` | ${detail} |`);
  }
  lines.push("");
  lines.push(
    `**${result.observed_count} of ${result.findings.length} signals observed** ` +
      `(${result.present_count} present, ${result.absent_count} absent, ` +
      `${result.not_observable_count} not observable with the current token` +
      (result.not_applicable_count > 0 ? `, ${result.not_applicable_count} not applicable` : "") +
      `).`,
  );
  return lines.join("\n") + "\n";
}
