import {
  computeGithubPlanDigest,
  normalizeBaseUrl,
  parseJsonOutput,
  requestJson,
  requireValue,
  run,
  safeErrorBody,
  sha256,
  writeEvidence,
  writeGithubOutput,
} from './lib.mjs';
import { pathToFileURL } from 'node:url';

export function classifySalesforceDeploy(commandResult, parsed, observationConfirmed) {
  const cliStatus = parsed?.result?.status || parsed?.statusName || null;
  const explicitSuccess = commandResult.status === 0 && Number(parsed?.status ?? 0) === 0 &&
    (!cliStatus || ['Succeeded', 'SucceededPartial'].includes(cliStatus));
  const explicitFailure = commandResult.status !== 0 || Number(parsed?.status ?? 0) !== 0 ||
    ['Failed', 'Canceled', 'Canceling'].includes(cliStatus);
  if (explicitSuccess && observationConfirmed === true) return 'success';
  if (explicitFailure) return 'failure';
  return 'unknown';
}

function responseId(parsed) {
  return parsed?.result?.id || parsed?.result?.deployId || parsed?.result?.details?.id || null;
}

function sfDeploy({ mode, targetOrg, candidateDir, packageManifest, emptyManifest, destructiveManifest, waitMinutes }) {
  const args = ['project', 'deploy', 'start', '--target-org', targetOrg];
  if (mode === 'cleanup') {
    args.push('--manifest', emptyManifest);
    args.push('--post-destructive-changes', destructiveManifest);
  } else {
    args.push('--manifest', packageManifest);
  }
  args.push('--wait', String(waitMinutes), '--test-level', 'NoTestRun', '--json');
  const result = run('sf', args, { cwd: candidateDir });
  return { result, parsed: parseJsonOutput(result.stdout) };
}

function observeMarker(targetOrg, mode) {
  const query = "SELECT Id, Name, Label FROM PermissionSet WHERE Name = 'AtlaSent_Pilot_Marker'";
  const command = run('sf', ['data', 'query', '--target-org', targetOrg, '--query', query, '--json']);
  const parsed = parseJsonOutput(command.stdout);
  if (command.status !== 0 || !parsed || Number(parsed.status ?? 0) !== 0) {
    return { confirmed: null, count: null, error: parsed?.message || command.stderr.trim().slice(0, 300) || 'query_failed' };
  }
  const count = Number(parsed?.result?.totalSize ?? parsed?.result?.records?.length ?? 0);
  return { confirmed: mode === 'cleanup' ? count === 0 : count === 1, count, error: null };
}

async function postOrThrow(url, token, body, label) {
  const response = await requestJson(url, { method: 'POST', token, body });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} (${safeErrorBody(response)})`);
  return response.data;
}

export async function main() {
  const env = process.env;
  if (env.ATLASENT_VERIFIED !== 'true') throw new Error('AtlaSent permit was not verified; native execution refused');
  const mode = requireValue('MODE', env.MODE);
  if (!['acceptance', 'cleanup'].includes(mode)) throw new Error('MODE must be acceptance or cleanup');
  const apiBase = normalizeBaseUrl(env.ATLASENT_BASE_URL);
  const apiKey = requireValue('ATLASENT_API_KEY', env.ATLASENT_API_KEY);
  const permitToken = requireValue('ATLASENT_PERMIT_TOKEN', env.ATLASENT_PERMIT_TOKEN);
  const decisionId = requireValue('ATLASENT_DECISION_ID', env.ATLASENT_DECISION_ID);
  const expectedDigest = requireValue('PLAN_DIGEST', env.PLAN_DIGEST);
  const repository = requireValue('GITHUB_REPOSITORY', env.GITHUB_REPOSITORY);
  const baseSha = requireValue('BASE_SHA', env.BASE_SHA);
  const headSha = requireValue('HEAD_SHA', env.HEAD_SHA);
  const headRef = requireValue('HEAD_REF', env.HEAD_REF);
  const candidateDir = requireValue('CANDIDATE_DIR', env.CANDIDATE_DIR);
  const targetOrg = requireValue('SF_TARGET_ORG', env.SF_TARGET_ORG);
  const sfOrgId = requireValue('SF_ORG_ID', env.SF_ORG_ID);
  const evidenceDir = requireValue('EVIDENCE_DIR', env.EVIDENCE_DIR);
  const prNumber = requireValue('PR_NUMBER', env.PR_NUMBER);
  const runId = requireValue('GITHUB_RUN_ID', env.GITHUB_RUN_ID);
  const runAttempt = env.GITHUB_RUN_ATTEMPT || '1';
  const actor = requireValue('GITHUB_ACTOR', env.GITHUB_ACTOR);
  const packageManifest = env.PACKAGE_MANIFEST || 'manifest/atlasent-pilot-package.xml';
  const emptyManifest = env.EMPTY_MANIFEST || 'manifest/package-empty.xml';
  const destructiveManifest = env.DESTRUCTIVE_MANIFEST || 'manifest/atlasent-pilot-destructive.xml';
  const waitMinutes = Number(env.SF_DEPLOY_WAIT_MINUTES || '30');

  const actualHead = run('git', ['-C', candidateDir, 'rev-parse', 'HEAD']).stdout.trim();
  if (actualHead.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error(`Candidate checkout changed: expected ${headSha}, found ${actualHead || 'unknown'}`);
  }
  const worktree = run('git', ['-C', candidateDir, 'status', '--porcelain', '--untracked-files=no']);
  if (worktree.status !== 0 || worktree.stdout.trim()) throw new Error('Candidate tracked files are not clean; execution refused');
  const actualDigest = computeGithubPlanDigest({ repository, baseSha, headSha, ref: headRef });
  if (actualDigest !== expectedDigest) {
    throw new Error(`Plan digest changed: expected ${expectedDigest}, recomputed ${actualDigest}`);
  }
  const payloadHash = expectedDigest.replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('PLAN_DIGEST is not sha256:<64 lowercase hex>');

  const intent = `${repository}#${prNumber}:${headSha}:${mode}`;
  const operationKey = `github:${sha256(intent)}`;
  const register = await postOrThrow(
    `${apiBase}/v1-consequential-operations/register`,
    apiKey,
    {
      operation_key: operationKey,
      operation_intent_id: intent,
      action_slug: 'production.deploy',
      environment: 'test',
      target_id: `salesforce:${sfOrgId}`,
      payload_hash: payloadHash,
      decision_id: decisionId,
      provider: 'salesforce_cli',
    },
    'AtlaSent operation registration',
  );
  const operationId = requireValue('operation_id', register.operation_id);
  const attempt = await postOrThrow(
    `${apiBase}/v1-consequential-operations/begin-attempt`,
    apiKey,
    {
      operation_id: operationId,
      provider_idempotency_key: intent,
      lease_seconds: Math.max(300, Math.ceil(waitMinutes * 60 + 300)),
    },
    'AtlaSent operation admission',
  );
  const attemptId = requireValue('attempt_id', attempt.attempt_id);

  const startedAt = new Date().toISOString();
  const deploy = sfDeploy({
    mode, targetOrg, candidateDir, packageManifest, emptyManifest, destructiveManifest, waitMinutes,
  });
  const completedAt = new Date().toISOString();
  const observation = observeMarker(targetOrg, mode);
  const outcome = classifySalesforceDeploy(deploy.result, deploy.parsed, observation.confirmed);
  const deploymentId = responseId(deploy.parsed);
  const safeObservation = {
    provider: 'salesforce_cli',
    mode,
    salesforce_org_id: sfOrgId,
    deployment_id: deploymentId,
    cli_exit_code: deploy.result.status,
    cli_status: deploy.parsed?.result?.status || null,
    marker_query_confirmed: observation.confirmed,
    marker_record_count: observation.count,
    marker_query_error: observation.error,
    repository,
    pull_request_number: Number(prNumber),
    base_sha: baseSha,
    head_sha: headSha,
    ref: headRef,
    canonical_plan_digest: expectedDigest,
    workflow_run_id: runId,
    workflow_run_attempt: runAttempt,
  };

  let recordError = null;
  let recorded = null;
  try {
    recorded = await postOrThrow(
      `${apiBase}/v1-consequential-operations/record-attempt`,
      apiKey,
      {
        operation_id: operationId,
        attempt_id: attemptId,
        outcome,
        ...(deploymentId ? { provider_request_id: String(deploymentId) } : {}),
        ...(Number.isInteger(deploy.result.status) ? { provider_response_code: deploy.result.status } : {}),
        observation: safeObservation,
      },
      'AtlaSent operation outcome recording',
    );
  } catch (error) {
    recordError = error.message;
  }

  let correlationError = null;
  let correlation = null;
  try {
    correlation = await postOrThrow(
      `${apiBase}/v1-production-change-closeout/execution`,
      apiKey,
      {
        decision_id: decisionId,
        permit_token_hash: sha256(permitToken),
        executed_github_revision: {
          repository,
          base_sha: baseSha,
          head_sha: headSha,
          ref: headRef,
          workflow: env.GITHUB_WORKFLOW || null,
          run_id: runId,
          ...(deploymentId ? { deployment_id: String(deploymentId) } : {}),
        },
        executed_at: completedAt,
        collector_version: 'atlasent-salesforce-starter/1',
      },
      'AtlaSent GitHub execution correlation',
    );
  } catch (error) {
    correlationError = error.message;
  }

  const consoleBase = (env.ATLASENT_CONSOLE_URL || 'https://console.atlasent.io').replace(/\/+$/, '');
  const evidence = {
    schema_version: 1,
    started_at: startedAt,
    completed_at: completedAt,
    mode,
    actor,
    decision_id: decisionId,
    operation_id: operationId,
    attempt_id: attemptId,
    operation_state: recorded?.state || null,
    outcome,
    deployment_id: deploymentId,
    observation: safeObservation,
    atlasent_record_error: recordError,
    execution_correlation: correlation?.execution_correlation || null,
    execution_correlation_error: correlationError,
    console: {
      authorization_lineage: `${consoleBase}/authorization/${encodeURIComponent(decisionId)}`,
      production_change_closeout: `${consoleBase}/action-evidence/${encodeURIComponent(decisionId)}/closeout`,
    },
  };
  writeEvidence(evidenceDir, `${mode}.json`, evidence);
  writeGithubOutput('decision_id', decisionId);
  writeGithubOutput('operation_id', operationId);
  writeGithubOutput('deployment_id', deploymentId || '');
  writeGithubOutput('outcome', outcome);
  writeGithubOutput('authorization_lineage_url', evidence.console.authorization_lineage);
  writeGithubOutput('closeout_url', evidence.console.production_change_closeout);

  if (recordError) throw new Error(`${recordError}; execution may have occurred and requires reconciliation`);
  if (correlationError) throw new Error(`${correlationError}; closeout genealogy is incomplete`);
  if (outcome !== 'success') {
    const detail = deploy.parsed?.message || deploy.parsed?.name || observation.error || deploy.result.stderr.trim().slice(0, 300);
    throw new Error(`Salesforce ${mode} outcome is ${outcome}${detail ? `: ${detail}` : ''}`);
  }
  console.log(`Salesforce ${mode} succeeded. Decision ${decisionId}; deployment ${deploymentId || 'not reported'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`EXECUTION_BLOCKED: ${error.message}`);
    process.exitCode = 1;
  });
}
