'use strict';

const { execFileSync } = require('child_process');

// Only missing credentials or a missing CLI warrant a public fallback.
// Rate limits, permissions and server errors must keep failing closed.
function isGhAuthError(err) {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  const text = `${err.stderr || ''}\n${err.message || ''}`;
  return /gh auth login|GH_TOKEN environment variable|not logged in|authentication required/i.test(text);
}

// A child preserves synchronous callers while opting into the cloud proxy,
// as check-workflow-run-status.js does. No authorization header is sent.
const FETCH_JSON = `
fetch(process.argv[1], {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'broadwayscore-public-check' },
  signal: AbortSignal.timeout(20000),
}).then(async res => {
  if (!res.ok) throw new Error('GitHub public API HTTP ' + res.status);
  process.stdout.write(JSON.stringify(await res.json()));
}).catch(err => {
  process.stderr.write(err.message + (err.cause ? ' (' + (err.cause.code || err.cause.message) + ')' : ''));
  process.exit(1);
});`;

/** Read gh's JSON shape, or map the public REST response after an auth failure. */
function ghApiJson(apiPath, { jq, mapRest = body => body, exec = execFileSync, env = process.env, cwd } = {}) {
  const options = { encoding: 'utf8', cwd, env, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  let stdout;
  try {
    stdout = exec('gh', ['api', apiPath, ...(jq ? ['--jq', jq] : [])], options);
  } catch (err) {
    if (!isGhAuthError(err)) throw err;
    // Fixed GitHub origin: a caller's API path cannot redirect to another host.
    if (!/^repos\/[\w.-]+\/[\w.-]+\//.test(apiPath)) throw new Error('public API fallback requires a repository path');
    const proxy = env.HTTPS_PROXY || env.https_proxy;
    const body = exec(process.execPath, ['--no-warnings', '-e', FETCH_JSON, `https://api.github.com/${apiPath}`], {
      ...options, timeout: 60000, env: { ...env, ...(proxy ? { NODE_USE_ENV_PROXY: '1' } : {}) },
    });
    return mapRest(JSON.parse(body));
  }
  return JSON.parse(stdout);
}

// Match ci-green-rate's existing gh --jq shape, preserving pagination IDs.
function normalizeRunsPage(body) {
  return {
    total: body.total_count,
    runs: Array.isArray(body.workflow_runs) ? body.workflow_runs.map(r => ({
      databaseId: r.id, headSha: r.head_sha, createdAt: r.created_at,
      updatedAt: r.updated_at, runStartedAt: r.run_started_at,
      conclusion: r.conclusion, status: r.status,
    })) : null,
  };
}

module.exports = { isGhAuthError, ghApiJson, normalizeRunsPage };
