import {
  computeGithubPlanDigest,
  findRequiredGithubCheck,
  githubCheckRuns,
  githubJson,
  githubPages,
  latestApprovedReviews,
  normalizeBaseUrl,
  parseJsonOutput,
  requestJson,
  requireValue,
  run,
  safeErrorBody,
  writeEvidence,
  writeGithubOutput,
} from './lib.mjs';
import { pathToFileURL } from 'node:url';

function assertStatus(response, expected, label) {
  if (!expected.includes(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status} (${safeErrorBody(response)})`);
  }
}

function sfJson(args) {
  const result = run('sf', [...args, '--json']);
  const data = parseJsonOutput(result.stdout);
  if (result.status !== 0 || !data || Number(data.status ?? 0) !== 0) {
    const detail = data?.message || data?.name || result.stderr.trim().slice(0, 300) || 'unknown Salesforce CLI error';
    throw new Error(`Salesforce CLI ${args.slice(0, 3).join(' ')} failed: ${detail}`);
  }
  return data.result;
}

export async function main() {
  const env = process.env;
  const apiBase = normalizeBaseUrl(env.ATLASENT_BASE_URL);
  const apiKey = requireValue('ATLASENT_API_KEY', env.ATLASENT_API_KEY);
  const githubToken = requireValue('GITHUB_TOKEN', env.GITHUB_TOKEN);
  const githubRepository = requireValue('GITHUB_REPOSITORY', env.GITHUB_REPOSITORY);
  const githubApi = requireValue('GITHUB_API_URL', env.GITHUB_API_URL || 'https://api.github.com');
  const githubSha = requireValue('GITHUB_SHA', env.GITHUB_SHA);
  const prNumber = Number(requireValue('PR_NUMBER', env.PR_NUMBER));
  const gearsetCheckName = requireValue('GEARSET_CHECK_NAME', env.GEARSET_CHECK_NAME);
  const minApprovals = Number(env.MIN_APPROVALS || '2');
  const targetOrg = requireValue('SF_TARGET_ORG', env.SF_TARGET_ORG);
  const expectedHost = requireValue('SF_EXPECTED_INSTANCE_HOST', env.SF_EXPECTED_INSTANCE_HOST).toLowerCase();
  const evidenceDir = requireValue('EVIDENCE_DIR', env.EVIDENCE_DIR);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('PR_NUMBER must be a positive integer');
  if (!Number.isInteger(minApprovals) || minApprovals < 0) throw new Error('MIN_APPROVALS must be a non-negative integer');
  if (env.CONFIRM_SANDBOX !== 'true') throw new Error('confirm_sandbox must be true; production orgs are refused');

  const pr = await githubJson(githubApi, `/repos/${githubRepository}/pulls/${prNumber}`, githubToken);
  if (pr.state !== 'open') throw new Error(`PR #${prNumber} is not open`);
  if (pr.head?.repo?.full_name !== githubRepository) {
    throw new Error('Fork pull requests are refused because this workflow uses protected environment credentials');
  }
  const baseSha = requireValue('PR base SHA', pr.base?.sha);
  const headSha = requireValue('PR head SHA', pr.head?.sha);
  const headRef = requireValue('PR head ref', pr.head?.ref);
  if (githubSha.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error(
      `This run is on ${githubSha.slice(0, 12)}, but PR #${prNumber} is on ${headSha.slice(0, 12)}. ` +
      `Re-run the workflow and select the PR branch "${headRef}" in GitHub's Run workflow branch selector.`,
    );
  }

  const [reviews, checkRuns, statuses, changedFiles] = await Promise.all([
    githubPages(githubApi, `/repos/${githubRepository}/pulls/${prNumber}/reviews`, githubToken),
    githubCheckRuns(githubApi, `/repos/${githubRepository}/commits/${headSha}/check-runs`, githubToken),
    githubPages(githubApi, `/repos/${githubRepository}/commits/${headSha}/statuses`, githubToken),
    githubPages(githubApi, `/repos/${githubRepository}/pulls/${prNumber}/files`, githubToken, 30),
  ]);
  if (Number(pr.changed_files) > 3000 || changedFiles.length !== Number(pr.changed_files)) {
    throw new Error(
      `GitHub returned ${changedFiles.length} of ${pr.changed_files} changed files; protected-path verification is incomplete`,
    );
  }
  const protectedIntegrationChanges = [...new Set(changedFiles
    .flatMap((item) => [item.filename, item.previous_filename])
    .filter(Boolean))]
    .filter((filename) =>
      filename === '.github/workflows/atlasent-salesforce-gate.yml' ||
      filename.startsWith('.atlasent/salesforce/'),
    );
  if (protectedIntegrationChanges.length > 0) {
    throw new Error(
      'This execution PR changes trusted AtlaSent integration code. Merge integration changes separately with CODEOWNER review, ' +
      `then run the pilot from a fresh PR. Protected paths: ${protectedIntegrationChanges.join(', ')}`,
    );
  }
  const approvalEvidence = latestApprovedReviews(reviews, { headSha });
  if (approvalEvidence.count < minApprovals) {
    throw new Error(
      `PR #${prNumber} has ${approvalEvidence.count} human approval(s) on the current head SHA; ${minApprovals} required. ` +
      `Current-head approvers: ${approvalEvidence.reviewers.join(', ') || 'none'}`,
    );
  }
  const gearset = findRequiredGithubCheck({ checkRuns, statuses, name: gearsetCheckName });
  if (!gearset) {
    const available = [...checkRuns.map((item) => item.name), ...statuses.map((item) => item.context)].filter(Boolean);
    throw new Error(
      `Required Gearset check "${gearsetCheckName}" was not found on ${headSha.slice(0, 12)}. ` +
      `Observed checks: ${available.join(', ') || 'none'}`,
    );
  }
  if (!gearset.successful) {
    throw new Error(`Gearset check "${gearset.name}" is ${gearset.state}; success is required`);
  }

  const planDigest = computeGithubPlanDigest({
    repository: githubRepository,
    baseSha,
    headSha,
    ref: headRef,
  });

  const health = await requestJson(`${apiBase}/v1-health`);
  assertStatus(health, [200], 'AtlaSent health');
  if (health.data?.status !== 'healthy') throw new Error(`AtlaSent runtime is ${health.data?.status || 'unknown'}`);

  const orgStatus = await requestJson(`${apiBase}/v1-org-status`, { token: apiKey });
  assertStatus(orgStatus, [200], 'AtlaSent org status');
  if (!orgStatus.data?.provisioned || !orgStatus.data?.engine_ready) {
    const flags = (orgStatus.data?.drift_flags || []).map((item) => item.code).join(', ');
    throw new Error(`AtlaSent org is not engine-ready${flags ? ` (${flags})` : ''}`);
  }

  // Deliberately invalid, zero-write probes. HTTP 400 proves authentication and
  // the required mutation scope passed before input validation; 403 means the
  // key lacks the scope, and 404 means the runtime route is not deployed.
  const opScope = await requestJson(`${apiBase}/v1-consequential-operations/register`, {
    method: 'POST', token: apiKey, body: {},
  });
  assertStatus(opScope, [400], 'AtlaSent consequential_operations:write probe');
  const correlationScope = await requestJson(`${apiBase}/v1-production-change-closeout/execution`, {
    method: 'POST', token: apiKey, body: {},
  });
  assertStatus(correlationScope, [400], 'AtlaSent production_change:write probe');

  const githubApp = await requestJson(`${apiBase}/v1-github-app-config`, { token: apiKey });
  assertStatus(githubApp, [200], 'AtlaSent GitHub App configuration');
  const installations = githubApp.data?.installations || [];
  const repoConfigs = githubApp.data?.repo_configs || [];
  const activeInstallationIds = new Set(installations.filter((item) => item.is_active).map((item) => item.id));
  const repoBinding = repoConfigs.find(
    (item) => item.repo_full_name === githubRepository && item.is_active && activeInstallationIds.has(item.installation_id),
  );
  if (!repoBinding || !repoBinding.action_class_id) {
    throw new Error(
      `AtlaSent GitHub App is not actively bound to ${githubRepository} with an action class. ` +
      'Connect the App and bind this repo to production.deploy before acceptance so execution evidence can be corroborated.',
    );
  }

  const display = sfJson(['org', 'display', '--target-org', targetOrg, '--verbose']);
  const instanceUrl = requireValue('Salesforce instance URL', display.instanceUrl);
  const displayHost = new URL(instanceUrl).host.toLowerCase();
  if (displayHost !== expectedHost) {
    throw new Error(`Salesforce host mismatch: connected to ${displayHost}, expected ${expectedHost}`);
  }
  const orgQuery = sfJson([
    'data', 'query', '--target-org', targetOrg,
    '--query', 'SELECT Id, IsSandbox, InstanceName, OrganizationType FROM Organization LIMIT 1',
  ]);
  const org = orgQuery?.records?.[0];
  if (!org) throw new Error('Salesforce Organization query returned no record');
  if (org.IsSandbox !== true) throw new Error('Connected Salesforce org is not a sandbox; execution refused');
  if (display.orgId && display.orgId !== org.Id) throw new Error('Salesforce org identity changed between display and query');

  const context = {
    approvals: approvalEvidence.count,
    approving_reviewers: approvalEvidence.reviewers,
    approval_source: 'github_pr_reviews',
    pr_number: prNumber,
    pr_url: pr.html_url,
    candidate_base_sha: baseSha,
    candidate_head_sha: headSha,
    candidate_ref: headRef,
    canonical_plan_digest: planDigest,
    gearset_check: gearset,
    salesforce_org_id: org.Id,
    salesforce_instance_host: displayHost,
    provider: 'salesforce_cli',
    operation_mode: env.MODE || 'preflight',
  };
  const evidence = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    mode: env.MODE || 'preflight',
    github: {
      repository: githubRepository,
      pull_request_number: prNumber,
      pull_request_url: pr.html_url,
      base_sha: baseSha,
      head_sha: headSha,
      head_ref: headRef,
      approvals: approvalEvidence,
      gearset,
      plan_digest: planDigest,
      runtime_sha_matches_pr_head: true,
    },
    atlasent: {
      status: health.data?.status,
      org_id: orgStatus.data?.org_id,
      engine_ready: orgStatus.data?.engine_ready,
      active_policy_count: orgStatus.data?.active_policy_count,
      engine_version: orgStatus.data?.engine_version,
      github_app_repo_binding_id: repoBinding.id,
      scope_probes: {
        evaluate_write: 'verified_by_v1_org_status',
        verify_execute: 'verified_at_acceptance_execution_boundary',
        consequential_operations_write: 'verified_by_zero_write_400_probe',
        production_change_write: 'verified_by_zero_write_400_probe',
        integrations_read: 'verified_by_github_app_config_read',
      },
    },
    salesforce: {
      org_id: org.Id,
      username: display.username || null,
      instance_url: instanceUrl,
      instance_host: displayHost,
      is_sandbox: true,
      instance_name: org.InstanceName || null,
      organization_type: org.OrganizationType || null,
    },
  };
  writeEvidence(evidenceDir, 'preflight.json', evidence);
  writeGithubOutput('base_sha', baseSha);
  writeGithubOutput('head_sha', headSha);
  writeGithubOutput('head_ref', headRef);
  writeGithubOutput('plan_digest', planDigest);
  writeGithubOutput('approvals', approvalEvidence.count);
  writeGithubOutput('approving_reviewers_json', approvalEvidence.reviewers);
  writeGithubOutput('pr_url', pr.html_url);
  writeGithubOutput('atla_org_id', orgStatus.data.org_id);
  writeGithubOutput('sf_org_id', org.Id);
  writeGithubOutput('sf_instance_url', instanceUrl);
  writeGithubOutput('context_json', context);
  console.log(
    `Preflight ready: PR #${prNumber} ${headSha.slice(0, 12)}, Gearset success, ` +
    `${approvalEvidence.count} approval(s), AtlaSent engine ready, Salesforce sandbox ${org.Id}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`PREFLIGHT_BLOCKED: ${error.message}`);
    process.exitCode = 1;
  });
}
