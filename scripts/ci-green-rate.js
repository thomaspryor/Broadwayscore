#!/usr/bin/env node
/**
 * ci-green-rate.js — machine verdict on whether main's Test Suite is green.
 *
 * ~45 sessions have each claimed "main is red" was fixed after a handful of
 * green runs. This script is the only thing that may say so, and it never
 * uses the word: it prints the green RATE over a fixed window, the trend,
 * and a PASS/FAIL against a threshold — never a bare PASS/FAIL without the
 * numbers. Owner reads the verdict line, not a session's claim:
 *
 *   CI-GREEN-RATE: rate X% (green G / red R, N runs[, C cancelled]),
 *     7d trend from Y%, day D of 14 at ≥M% → PASS|FAIL [(reason)]
 *
 * Usage:
 *   node scripts/ci-green-rate.js [--days 7] [--min 80] [--json] [--record]
 *                                 [--workflow test.yml] [--branch main] [--max-pages 10]
 *
 * Exit codes:  0 PASS   1 FAIL   2 usage / gh API error (never a PASS)
 *
 * Reaches the owner two ways:
 *   - as a safe-form acceptance command (scripts/lib/autonomous-triage-core.js
 *     SAFE_CHECK_FORMS admits `--days 7-365`, `--min 50-100`, `--json` ONLY —
 *     never --record), where the exit code is the verdict;
 *   - as health-check.js's "Main: green rate" row (checkCiGreenRate), which
 *     runs `--days 7 --json --record` nightly in CI so the reading lands in
 *     data/audit/ci-green-rate.jsonl and the digest shows the trend line.
 *
 * READ-ONLY except `--record`, which appends one JSON line to the ledger.
 * Network = one-shot `gh api` GET of the Actions REST runs endpoint
 * (per_page=100, paginated up to --max-pages), the same endpoint
 * scripts/ci-health-check.sh and scripts/health-check.js use — NEVER `gh run
 * list --limit` (BRO-2771: stale result sets on this repo). Not a polling
 * loop: one fetch, then exit. A rate-limit 403 exits 2 without retrying
 * (memory/feedback_github_polling_rate_limit.md). Definitions of green/red/
 * cancelled, rerun collapse, streaks, latency and trend live in
 * scripts/lib/ci-green-rate.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const core = require('./lib/ci-green-rate.js');

const REPO_ROOT = path.join(__dirname, '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'data', 'audit', 'ci-green-rate.jsonl');
const JQ = '.workflow_runs | map({databaseId: .id, headSha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, runStartedAt: .run_started_at, conclusion: .conclusion, status: .status})';

function usage() {
  return [
    'Usage: node scripts/ci-green-rate.js [--days N] [--min M] [--json] [--record] [--workflow FILE] [--branch NAME] [--max-pages P]',
    '  --days N       window in days (default 7)',
    '  --min M        minimum green rate percent for PASS (default 80)',
    '  --json         print the full result object instead of the table',
    '  --record       append this reading to data/audit/ci-green-rate.jsonl (health-check.js nightly; not an acceptance form)',
    'Exit 0 = PASS, 1 = FAIL, 2 = usage or gh API error.',
  ].join('\n');
}

/**
 * `owner/repo` of this checkout's `origin`, resolved explicitly so a GH_REPO
 * in the environment can never point the query at another repository
 * (gh-runs-query.sh documents that override). null if unresolvable.
 */
function resolveRepo(exec = execFileSync) {
  try {
    const url = exec('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return core.parseRepoFromRemote(url);
  } catch {
    return null;
  }
}

/** Ledger rows (read-only; a missing or partly-corrupt file is just fewer rows). */
function readLedger(file = LEDGER_PATH) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return rows;
}

function appendLedger(row, file = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/**
 * One-shot paginated fetch against an EXPLICIT repo (never the
 * `{owner}/{repo}` placeholder). Returns { runs, truncated }.
 */
function fetchRuns({ repo, workflow, branch, days, maxPages, now }, exec = execFileSync) {
  if (!repo) throw new Error('fetchRuns: repo is required');
  const sinceDate = core.windowStartDate(days, now);
  const runs = [];
  let truncated = false;
  const env = { ...process.env };
  delete env.GH_REPO; // belt-and-braces: the path is explicit, but never let an override leak into gh
  for (let page = 1; page <= maxPages; page++) {
    const apiPath = core.buildRunsApiPath({ repo, workflow, branch, page, sinceDate, perPage: core.DEFAULTS.perPage });
    const stdout = exec('gh', ['api', apiPath, '--jq', JQ], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error('unexpected gh api payload (not an array after --jq)');
    runs.push(...rows);
    if (rows.length < core.DEFAULTS.perPage) break;
    if (page === maxPages) truncated = true;
  }
  return { runs, truncated };
}

/**
 * @param {string[]} argv
 * @param {{exec?: typeof execFileSync, now?: number, log?: Function, error?: Function, repo?: string|null, ledgerRows?: Array<object>, record?: (row: object) => void}} [deps]
 *   injectable for tests (pattern: scripts/lib/card-arming-warning.js's deps)
 * @returns {number} exit code
 */
function main(argv, deps = {}) {
  const exec = deps.exec || execFileSync;
  const log = deps.log || console.log;
  const error = deps.error || console.error;
  // --help before ANY work (scripts/audit-help-flag-safety.js Rule B: a
  // script that spawns must never reach the spawn on a help request).
  if (hasHelpFlag(argv)) {
    log(usage());
    return 0;
  }
  const opts = core.parseCliArgs(argv);
  if (opts.error) {
    error(`ci-green-rate: ${opts.error}\n${usage()}`);
    return 2;
  }

  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const repo = 'repo' in deps ? deps.repo : resolveRepo(exec);
  if (!repo) {
    error('ci-green-rate: could not resolve owner/repo from `git remote get-url origin` — refusing to query an unidentified repository');
    log(`CI-GREEN-RATE: n/a over ${opts.days}d — repo unresolved, no verdict`);
    return 2;
  }
  let fetched;
  try {
    fetched = fetchRuns({ repo, workflow: opts.workflow, branch: opts.branch, days: opts.days, maxPages: opts.maxPages, now }, exec);
  } catch (err) {
    const stderr = String((err && err.stderr) || '').trim();
    const msg = `${err && err.message ? err.message : err}${stderr ? ` — ${stderr.slice(0, 300)}` : ''}`;
    const rateLimited = /rate limit|403/i.test(msg);
    error(`ci-green-rate: gh api fetch failed${rateLimited ? ' (rate-limited — not retrying; check `gh api rate_limit`)' : ''}: ${msg}`);
    // On STDOUT on purpose: a consumer that keeps only the CI-GREEN-RATE line
    // must see "unavailable", never silence (Codex review finding).
    log(`CI-GREEN-RATE: n/a over ${opts.days}d — gh api fetch failed${rateLimited ? ' (rate-limited)' : ''}, no verdict`);
    return 2;
  }

  const ledgerRows = Array.isArray(deps.ledgerRows) ? deps.ledgerRows : readLedger();
  const result = core.computeGreenRate(fetched.runs, {
    days: opts.days, min: opts.min, now, workflow: opts.workflow, branch: opts.branch, repo, truncated: fetched.truncated, ledgerRows,
  });
  result.fetchedRuns = fetched.runs.length;
  if (fetched.truncated) {
    error(`ci-green-rate: WARN page cap (--max-pages ${opts.maxPages} x ${core.DEFAULTS.perPage}) reached — window incomplete, verdict forced FAIL; raise --max-pages`);
  }
  if (opts.record) {
    const row = core.ledgerRow(result);
    (deps.record || appendLedger)(row);
    result.recorded = row;
  }

  if (opts.json) log(JSON.stringify(result, null, 2));
  else log(core.formatReport(result));
  return result.verdict === 'PASS' ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, fetchRuns, resolveRepo, readLedger, LEDGER_PATH };
