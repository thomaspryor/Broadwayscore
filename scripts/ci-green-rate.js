#!/usr/bin/env node
/**
 * ci-green-rate.js — machine verdict on whether main's Test Suite is green.
 *
 * ~45 sessions have each claimed "main is red" was fixed after a handful of
 * green runs. This script is the only thing that may say so, and it never
 * uses the word: it prints a green RATE over a fixed window and a PASS/FAIL
 * against a threshold. Owner reads the verdict line, not a session's claim.
 *
 *   CI-GREEN-RATE: <rate>% over <N>d (green G / red R), min <M>% → PASS|FAIL
 *
 * Usage:
 *   node scripts/ci-green-rate.js [--days 7] [--min 80] [--json]
 *                                 [--workflow test.yml] [--branch main] [--max-pages 10]
 *
 * Exit codes:  0 PASS   1 FAIL   2 usage / gh API error (never a PASS)
 *
 * READ-ONLY. No fs writes. Network = one-shot `gh api` GET of the Actions
 * REST runs endpoint (per_page=100, paginated up to --max-pages), the same
 * endpoint scripts/ci-health-check.sh and scripts/health-check.js use —
 * NEVER `gh run list --limit` (BRO-2771: stale result sets on this repo).
 * Not a polling loop: one fetch, then exit. A rate-limit 403 exits 2 without
 * retrying (memory/feedback_github_polling_rate_limit.md).
 *
 * Registered as a safe-form acceptance command in
 * scripts/lib/autonomous-triage-core.js (SAFE_CHECK_FORMS) with the exact
 * flag shape above. Definitions of green/red/cancelled, streaks and the
 * red→green latency live in scripts/lib/ci-green-rate-core.js.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./lib/ci-green-rate-core.js');

const REPO_ROOT = path.join(__dirname, '..');
const JQ = '.workflow_runs | map({databaseId: .id, headSha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, conclusion: .conclusion, status: .status})';

function usage() {
  return [
    'Usage: node scripts/ci-green-rate.js [--days N] [--min M] [--json] [--workflow FILE] [--branch NAME] [--max-pages P]',
    '  --days N       window in days (default 7)',
    '  --min M        minimum green rate percent for PASS (default 80)',
    '  --json         print the full result object instead of the table',
    'Exit 0 = PASS, 1 = FAIL, 2 = usage or gh API error.',
  ].join('\n');
}

/**
 * One-shot paginated fetch. `{owner}/{repo}` is expanded by gh from the
 * checkout at REPO_ROOT (cwd is pinned so a caller's cwd cannot change the
 * repo). Returns { runs, truncated }.
 */
function fetchRuns({ workflow, branch, days, maxPages, now }) {
  const sinceDate = core.windowStartDate(days, now);
  const runs = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const apiPath = core.buildRunsApiPath({ workflow, branch, page, sinceDate, perPage: core.DEFAULTS.perPage });
    const stdout = execFileSync('gh', ['api', apiPath, '--jq', JQ], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
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

function main(argv) {
  const opts = core.parseCliArgs(argv);
  if (opts.error) {
    console.error(`ci-green-rate: ${opts.error}\n${usage()}`);
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const now = Date.now();
  let fetched;
  try {
    fetched = fetchRuns({ workflow: opts.workflow, branch: opts.branch, days: opts.days, maxPages: opts.maxPages, now });
  } catch (err) {
    const stderr = String((err && err.stderr) || '').trim();
    const msg = `${err && err.message ? err.message : err}${stderr ? ` — ${stderr.slice(0, 300)}` : ''}`;
    const rateLimited = /rate limit|403/i.test(msg);
    console.error(`ci-green-rate: gh api fetch failed${rateLimited ? ' (rate-limited — not retrying; check `gh api rate_limit`)' : ''}: ${msg}`);
    console.error('CI-GREEN-RATE: n/a — fetch failed, no verdict');
    return 2;
  }

  const result = core.computeGreenRate(fetched.runs, { days: opts.days, min: opts.min, now, workflow: opts.workflow, branch: opts.branch });
  result.fetchedRuns = fetched.runs.length;
  result.truncated = fetched.truncated;
  if (fetched.truncated) {
    console.error(`ci-green-rate: WARN page cap (--max-pages ${opts.maxPages} x ${core.DEFAULTS.perPage}) reached — window may be incomplete; raise --max-pages`);
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(core.formatReport(result));
  return result.verdict === 'PASS' ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, fetchRuns };
