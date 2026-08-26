import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function computeGithubPlanDigest({ repository, baseSha, headSha, ref = null }) {
  const projection = {
    plan_format: 'git-sha',
    repository,
    base_sha: baseSha,
    head_sha: headSha,
    ref: ref || null,
  };
  return `sha256:${sha256(canonicalize(projection))}`;
}

export function requireValue(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function normalizeBaseUrl(raw) {
  const value = requireValue('ATLASENT_BASE_URL', raw).replace(/\/+$/, '');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('ATLASENT_BASE_URL must use https');
  if (!url.pathname.endsWith('/functions/v1')) {
    throw new Error('ATLASENT_BASE_URL must end with /functions/v1');
  }
  return value;
}

export async function requestJson(url, {
  method = 'GET',
  token,
  body,
  headers = {},
  timeoutMs = 20_000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { unparsed: text.slice(0, 500) };
      }
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function githubJson(apiBase, path, token) {
  const response = await requestJson(`${apiBase.replace(/\/+$/, '')}${path}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
  }
  return response.data;
}

export async function githubPages(apiBase, path, token, maxPages = 10) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await githubJson(apiBase, `${path}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) throw new Error(`GitHub API ${path} did not return an array`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

export async function githubCheckRuns(apiBase, path, token, maxPages = 10) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const envelope = await githubJson(
      apiBase,
      `${path}${separator}filter=latest&per_page=100&page=${page}`,
      token,
    );
    const batch = envelope?.check_runs;
    if (!Array.isArray(batch)) throw new Error(`GitHub API ${path} did not return check_runs`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

export function latestApprovedReviews(reviews, { headSha = null } = {}) {
  const stateful = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
  const latest = new Map();
  for (const review of reviews) {
    const login = review?.user?.login;
    const state = String(review?.state || '').toUpperCase();
    if (login && stateful.has(state)) {
      latest.set(login, {
        state,
        commitId: review?.commit_id || null,
        userType: review?.user?.type || null,
      });
    }
  }
  const reviewers = [...latest.entries()]
    .filter(([, review]) =>
      review.state === 'APPROVED' &&
      review.userType !== 'Bot' &&
      (!headSha || String(review.commitId || '').toLowerCase() === String(headSha).toLowerCase()),
    )
    .map(([login]) => login)
    .sort();
  return { count: reviewers.length, reviewers };
}

function sameName(actual, expected) {
  return String(actual || '').trim().toLowerCase() === String(expected || '').trim().toLowerCase();
}

export function findRequiredGithubCheck({ checkRuns = [], statuses = [], name }) {
  const run = checkRuns.find((item) => sameName(item.name, name));
  if (run) {
    return {
      source: 'check_run',
      name: run.name,
      state: run.status === 'completed' ? run.conclusion : run.status,
      successful: run.status === 'completed' && run.conclusion === 'success',
      url: run.html_url || null,
    };
  }
  const status = statuses.find((item) => sameName(item.context, name));
  if (status) {
    return {
      source: 'commit_status',
      name: status.context,
      state: status.state,
      successful: status.state === 'success',
      url: status.target_url || null,
    };
  }
  return null;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

export function parseJsonOutput(stdout) {
  const value = String(stdout || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf('{');
    if (start >= 0) {
      try {
        return JSON.parse(value.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function writeGithubOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  appendFileSync(file, `${name}=${serialized.replace(/\r?\n/g, '')}\n`, 'utf8');
}

export function writeEvidence(directory, filename, value) {
  mkdirSync(directory, { recursive: true });
  const path = `${directory.replace(/\/$/, '')}/${filename}`;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export function safeErrorBody(response) {
  const code = response?.data?.code || response?.data?.error || 'unknown_error';
  const message = response?.data?.message || response?.data?.error_description || '';
  return `${code}${message ? `: ${String(message).slice(0, 240)}` : ''}`;
}
