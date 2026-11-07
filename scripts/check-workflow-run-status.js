#!/usr/bin/env node
/**
 * check-workflow-run-status.js — machine-checkable acceptance criteria for
 * cards whose intent is "the last run of workflow X (on branch Y) passed"
 * (BRO-2208).
 *
 * Why this exists instead of a bare `gh run list` SAFE_CHECK_FORM: `gh run
 * list` is a GET that exits 0 whenever it can talk to the API, regardless of
 * what the runs it lists actually say — piping it through `--json`/`--jq`
 * only reshapes its stdout, it never changes gh's own exit code. A card
 * whose "verify" command is a bare `gh run list ...` would pass unattended
 * re-verification unconditionally, which is a worse outcome than being
 * refused outright (a silent rubber stamp, not a stuck card) — exactly the
 * vacuous-check failure mode classifyVacuousCheck() (card-premises-
 * auditor.js) already guards against for `test -f` cards. This wrapper
 * fetches the most recent matching run and asserts its conclusion itself,
 * so the exit code is a real pass/fail signal.
 *
 * Exit codes: 0 conclusion matches --expect · 1 no match / no runs / gh
 * error · 2 usage error
 *
 * No gh auth (the done-gate's token-free env): falls back to the public REST
 * API, see fetchWorkflowRuns (BRO-5661).
 *
 * Multi-run mode (BRO-3579): `--limit=N` inspects the N most recent runs and
 * `--min-match=K` / `--max-match=K` bound how many of them may conclude
 * `--expect`. "3 consecutive successes" = --limit=3 --expect=success
 * --min-match=3; "at most 1 failure in last 5" = --limit=5 --expect=failure
 * --max-match=1; "none cancelled in last 20" = --limit=20 --expect=cancelled
 * --max-match=0. Without --limit the single most-recent-run check is unchanged.
 *
 * Usage:
 *   node scripts/check-workflow-run-status.js --workflow=<name.yml or "Display Name"> \
 *     --expect=<success|failure|cancelled|...> [--branch=<name>] \
 *     [--limit=N [--min-match=K] [--max-match=K]]
 */

'use strict';

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/check-workflow-run-status.js --workflow=<name.yml or "Display Name"> --expect=<conclusion> [--branch=<name>] [--limit=N [--min-match=K] [--max-match=K]]';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const eq = a.indexOf('=');
    if (!a.startsWith('--') || eq === -1) continue;
    out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

const MAX_LIMIT = 50;

function parseCount(v, name, min) {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > MAX_LIMIT) {
    throw new Error(`--${name} must be an integer ${min}-${MAX_LIMIT}`);
  }
  return Number(v);
}

/** Pure verdict: runs is gh's newest-first array. Returns { ok, message }. */
function evaluate(runs, { expect, limit, minMatch, maxMatch }) {
  if (!Array.isArray(runs) || runs.length === 0) return { ok: false, message: 'No runs found' };
  if (limit === undefined) {
    const run = runs[0];
    const ok = run.conclusion === expect;
    return { ok, message: `${ok ? 'MATCH' : 'MISMATCH'} — most recent run concluded '${run.conclusion || run.status}'${ok ? '' : `, expected '${expect}'`} (${run.url})` };
  }
  // Only finished runs count: an in-progress/queued run has no conclusion yet
  // and must not be credited as "not failed". Fewer finished runs than --limit
  // always fails — a young workflow cannot satisfy a "last N" claim.
  const window = runs.filter((r) => r.conclusion).slice(0, limit);
  const matches = window.filter((r) => r.conclusion === expect).length;
  const ok = window.length >= limit
    && (minMatch === undefined || matches >= minMatch)
    && (maxMatch === undefined || matches <= maxMatch);
  return { ok, message: `${ok ? 'MATCH' : 'MISMATCH'} — ${matches}/${window.length} of last ${limit} runs concluded '${expect}' (min ${minMatch ?? '-'}, max ${maxMatch ?? '-'})` };
}

// ── Public-API fallback (BRO-5661) ─────────────────────────────────────────
// linear-done-gate runs VERIFY commands under checksEnv() (autonomous-
// checks.js): fake HOME, no tokens. gh then has no config and no GH_TOKEN, so
// it exits "gh auth login" and every "Auto-fix: <workflow> Failed" card was
// refused even when the workflow was green. The repo is public, so the same
// runs are readable unauthenticated. No token is ever sent from here.
const PUBLIC_REPO = 'thomaspryor/Broadwayscore';
const API = 'https://api.github.com';

/** True when gh failed for lack of auth (or is not installed), the only cases the fallback covers. */
function isGhAuthError(err) {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  const text = `${err.stderr || ''}\n${err.message || ''}`;
  return /gh auth login|GH_TOKEN environment variable|not logged in|authentication required/i.test(text);
}

/** REST run → the gh `--json conclusion,status,headBranch,url` shape evaluate() reads. */
function normalizeRestRun(run) {
  return { conclusion: run.conclusion || '', status: run.status, headBranch: run.head_branch, url: run.html_url };
}

/** Workflow id from the list API: match file basename (x.yml) or display name. null when absent. */
function resolveWorkflowId(workflows, name) {
  const hit = (workflows || []).find((w) => (w.path && w.path.split('/').pop() === name) || w.name === name);
  return hit ? hit.id : null;
}

// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set
// at startup. Behind a proxy (the cloud container) the direct path shares one
// egress IP whose unauthenticated quota is exhausted, so run the request in a
// child Node that honours the proxy. Without a proxy (Mac, CI): plain fetch.
function proxyAwareFetch(env = process.env) {
  const proxied = (env.HTTPS_PROXY || env.https_proxy) && env.NODE_USE_ENV_PROXY !== '1';
  if (!proxied) return globalThis.fetch;
  return async (url, opts) => {
    const script = 'fetch(process.argv[1], JSON.parse(process.argv[2])).then(async r => process.stdout.write(JSON.stringify({ status: r.status, body: await r.text() }))).catch(e => { process.stderr.write(String(e.cause && e.cause.code || e.message)); process.exit(1); })';
    let out;
    try {
      out = execFileSync(process.execPath, ['--no-warnings', '-e', script, url, JSON.stringify(opts || {})], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, NODE_USE_ENV_PROXY: '1' },
      });
    } catch (e) {
      throw new Error(`fetch ${url} failed: ${(e.stderr || e.message || '').toString().trim()}`);
    }
    const { status, body } = JSON.parse(out);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) };
  };
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'broadwayscore-check-workflow-run-status' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Newest-first runs for `workflow` via the unauthenticated public REST API.
 * A file name (x.yml) is addressed directly; a display name is resolved by
 * paging the workflow list (the repo has ~300 workflows, 100 per page).
 */
async function fetchWorkflowRuns({ workflow, branch, limit = 1, completedOnly = false, repo = PUBLIC_REPO, fetchImpl = proxyAwareFetch() }) {
  let id = /\.ya?ml$/.test(workflow) ? workflow : null;
  for (let page = 1; !id; page++) {
    const body = await getJson(fetchImpl, `${API}/repos/${repo}/actions/workflows?per_page=100&page=${page}`);
    const list = body.workflows || [];
    id = resolveWorkflowId(list, workflow);
    if (!id && (list.length < 100 || page >= 10)) throw new Error(`workflow '${workflow}' not found in ${repo}`);
  }
  const q = new URLSearchParams({ per_page: String(limit) });
  if (branch) q.set('branch', branch);
  if (completedOnly) q.set('status', 'completed');
  const body = await getJson(fetchImpl, `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(id)}/runs?${q}`);
  return (body.workflow_runs || []).map(normalizeRestRun);
}

async function main(argv) {
  argv = argv || [];
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const { workflow, branch, expect, limit: limitRaw, 'min-match': minRaw, 'max-match': maxRaw } = parseArgs(argv);
  if (!workflow || !expect) {
    console.error(USAGE);
    process.exit(2);
  }
  let limit, minMatch, maxMatch;
  try {
    limit = parseCount(limitRaw, 'limit', 1);
    minMatch = parseCount(minRaw, 'min-match', 0);
    maxMatch = parseCount(maxRaw, 'max-match', 0);
    if (limit === undefined && (minMatch !== undefined || maxMatch !== undefined)) throw new Error('--min-match/--max-match require --limit');
    if (limit !== undefined && minMatch === undefined && maxMatch === undefined) throw new Error('--limit requires --min-match and/or --max-match');
    // Reject bounds that can never fail (vacuous) or never pass.
    if (minMatch === 0 && maxMatch === undefined) throw new Error('--min-match=0 alone is vacuous');
    if (minMatch > limit) throw new Error('--min-match cannot exceed --limit');
    if (maxMatch >= limit) throw new Error('--max-match must be below --limit (otherwise vacuous)');
    if (minMatch > maxMatch) throw new Error('--min-match cannot exceed --max-match');
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }

  const args = ['run', 'list', '--workflow', workflow, '--limit', String(limit || 1), '--json', 'conclusion,status,headBranch,url'];
  if (limit !== undefined) args.push('--status', 'completed');
  if (branch) args.push('--branch', branch);

  let stdout;
  let runs;
  try {
    stdout = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (!isGhAuthError(err)) {
      console.error(`gh run list failed: ${err.message}`);
      process.exit(1);
    }
    try {
      runs = await fetchWorkflowRuns({ workflow, branch, limit: limit || 1, completedOnly: limit !== undefined });
      console.error('(gh not authenticated; read runs from the public GitHub API)');
    } catch (e) {
      console.error(`gh not authenticated and public API fallback failed: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`);
      process.exit(1);
    }
  }

  if (runs === undefined) {
    try {
      runs = JSON.parse(stdout);
    } catch {
      console.error(`gh returned non-JSON output: ${stdout.slice(0, 200)}`);
      process.exit(1);
    }
  }

  const { ok, message } = evaluate(runs, { expect, limit, minMatch, maxMatch });
  const label = `${workflow}${branch ? `@${branch}` : ''}`;
  (ok ? console.log : console.error)(`${label}: ${message}`);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { parseArgs, evaluate, parseCount, isGhAuthError, normalizeRestRun, resolveWorkflowId, fetchWorkflowRuns, proxyAwareFetch, PUBLIC_REPO };
