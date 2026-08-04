#!/usr/bin/env node
/**
 * produce-trunk-snapshot.js — writes data/audit/trunk-status-snapshot.json:
 * is test.yml green on main right now, for how long has it been red, and
 * which FILES are named in the failures (task #1003).
 *
 * Two consumers, both in scripts/lib/trunk-close-gate.js:
 *   - the close-time gate in notion-brain.js (a card cannot go Done while a
 *     file IT owns is failing on main)
 *   - the standing "trunk: GREEN/RED" line in the morning digest
 *
 * gh CLI, not the REST API via fetch: `gh run view --log-failed` is the only
 * cheap way to get the failure text, and gh already carries this machine's
 * auth. Two gh calls per run (list + jobs) plus one log download — well under
 * the polling cadence CLAUDE.md warns about (never `gh run watch`).
 *
 *   node scripts/produce-trunk-snapshot.js              write the snapshot
 *   node scripts/produce-trunk-snapshot.js --dry-run    print, don't write
 *   node scripts/produce-trunk-snapshot.js --max-age-min=60
 *       no-op if the existing snapshot is younger than N minutes (the
 *       close-time gate uses this so a card close costs zero gh calls when a
 *       recent snapshot already exists)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { summarizeTrunkRuns, extractFailingPaths } = require('./lib/trunk-close-gate.js');

const REPO = path.join(__dirname, '..');
const SNAPSHOT_PATH = path.join(REPO, 'data', 'audit', 'trunk-status-snapshot.json');
const WORKFLOW = 'test.yml';
const BRANCH = 'main';
// 100 = one API page, and wide enough that a multi-day red usually still
// contains the last green — without it redSince is just the window floor
// (2026-08-04: 23 failures, zero successes in 25 runs).
const RUN_LIMIT = 100;

const USAGE = `produce-trunk-snapshot.js — record test.yml-on-main state for the close gate + digest
  node scripts/produce-trunk-snapshot.js                 write data/audit/trunk-status-snapshot.json
  node scripts/produce-trunk-snapshot.js --dry-run       print the snapshot, write nothing
  node scripts/produce-trunk-snapshot.js --max-age-min=N skip if the existing snapshot is younger than N minutes
  node scripts/produce-trunk-snapshot.js --help, -h      print this usage and exit — no reads/writes
`;

function gh(args, { maxBuffer = 64 * 1024 * 1024, timeout = 120000 } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer, timeout, cwd: REPO });
}

function snapshotIsFresh(maxAgeMin) {
  if (!Number.isFinite(maxAgeMin) || maxAgeMin <= 0) return false;
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const t = new Date(snap.generatedAt).getTime();
    return Number.isFinite(t) && (Date.now() - t) / 60000 < maxAgeMin;
  } catch {
    return false;
  }
}

/**
 * Failing jobs + the files their failures name. Kept separate from the pure
 * summarizer so all gh I/O lives in this file.
 */
function inspectFailedRun(runId) {
  let failingJobs = [];
  try {
    const jobsJson = JSON.parse(gh(['run', 'view', String(runId), '--json', 'jobs']));
    failingJobs = (jobsJson.jobs || [])
      .filter((j) => j && j.conclusion === 'failure')
      .map((j) => ({
        name: j.name,
        steps: (j.steps || []).filter((s) => s && s.conclusion === 'failure').map((s) => s.name),
      }));
  } catch (e) {
    console.error(`[trunk-snapshot] WARN could not read jobs for run ${runId}: ${String(e.message).slice(0, 120)}`);
  }

  let failingPaths = [];
  try {
    failingPaths = extractFailingPaths(gh(['run', 'view', String(runId), '--log-failed']));
  } catch (e) {
    // A log that won't download (expired, too large, rate limit) must leave
    // failingPaths EMPTY, which makes the close gate fail open — never guess
    // an attribution from a partial read.
    console.error(`[trunk-snapshot] WARN could not read failed log for run ${runId}: ${String(e.message).slice(0, 120)}`);
  }

  // "Test Summary" is a roll-up job that fails because something else did —
  // naming it as the top failing job would point every reader at the wrong
  // place, so it only wins when it is the ONLY failing job.
  const real = failingJobs.filter((j) => !/^test summary$/i.test(j.name || ''));
  const topFailingJob = (real[0] || failingJobs[0] || {}).name || null;
  return { failingJobs, failingPaths, topFailingJob };
}

function buildSnapshot({ now = Date.now() } = {}) {
  const runs = JSON.parse(gh([
    'run', 'list', '--workflow', WORKFLOW, '--branch', BRANCH,
    '--limit', String(RUN_LIMIT), '--json', 'databaseId,conclusion,createdAt,url,headSha',
  ]));
  const trunk = summarizeTrunkRuns(runs, { now });
  const snap = {
    generatedAt: new Date(now).toISOString(),
    workflow: WORKFLOW,
    branch: BRANCH,
    // Which commit the newest decided run tested — so a stale-looking refusal
    // can be traced to an actual sha instead of just a timestamp.
    latestRunHeadSha: (runs.find((r) => r && r.conclusion) || {}).headSha || null,
    ...trunk,
    failingJobs: [],
    failingPaths: [],
    topFailingJob: null,
  };
  if (trunk.state === 'RED' && trunk.latestFailedRunId) {
    Object.assign(snap, inspectFailedRun(trunk.latestFailedRunId));
  }
  return snap;
}

function main() {
  // --help/-h before any read/write (help-flag safety Rule B, task #498).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const maxAgeArg = argv.find((a) => a.startsWith('--max-age-min='));
  const maxAgeMin = maxAgeArg ? Number(maxAgeArg.split('=')[1]) : NaN;

  if (!dryRun && snapshotIsFresh(maxAgeMin)) {
    console.log(`[trunk-snapshot] existing snapshot younger than ${maxAgeMin}min — skipping`);
    return;
  }

  let snap;
  try {
    snap = buildSnapshot();
  } catch (e) {
    // No gh, no auth, rate limit: exit 2, write nothing. The gate reads
    // "no snapshot" as fail-open, and the digest omits the line — neither
    // may be turned into a false GREEN by a producer that couldn't look.
    console.error(`[trunk-snapshot] could not read trunk state: ${String(e.message).slice(0, 200)}`);
    process.exitCode = 2;
    return;
  }

  const line = snap.state === 'RED'
    ? `RED — ${snap.consecutiveFailures} consecutive failures, top job: ${snap.topFailingJob || 'unknown'}, ${snap.failingPaths.length} file(s) attributed`
    : `${snap.state} — last success ${snap.lastSuccessAt || 'unknown'}`;
  console.log(`[trunk-snapshot] ${line}`);

  if (dryRun) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + '\n');
  console.log(`[trunk-snapshot] wrote ${SNAPSHOT_PATH}`);
}

if (require.main === module) main();

module.exports = { buildSnapshot, inspectFailedRun, SNAPSHOT_PATH };
