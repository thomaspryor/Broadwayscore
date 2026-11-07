#!/usr/bin/env node
/**
 * audit-awards-freshness.js — data/awards.json must change at least once
 * every ~14 months (annual awards cadence: Tony, Pulitzer, DD, OCC, DL,
 * NYDCC, Olivier; 12-month cycle + 2 months grace for a late ceremony —
 * the Tonys were in September in 2021).
 *
 * BRO-4434 (2026-09-30): this used to be test.yml's `awards-data-freshness`
 * job. Main's Test Suite color means "the code is healthy"; a data file's
 * age is outside state, so the check now runs as a check-corpus-drift.js
 * AUDITS entry (daily). Its drift line reaches the digest and, after the
 * router's escalation threshold, a Linear card — the runbook for which is
 * memory/awards-annual-update.md.
 *
 * Last-touch date comes from the GitHub commits-by-path API (O(1)), not
 * `git log`: the public repo has 130k+ commits at ~2-min churn, and even a
 * 14-month --shallow-since fetch pulls most of history (2026-06-30, Notion
 * 38f637c5). `gh api` honours GH_TOKEN / GITHUB_TOKEN; the runner's default
 * token is enough (public repo, read).
 *
 * Usage:
 *   node scripts/audit-awards-freshness.js            # exit 0 fresh / 1 stale or could-not-determine
 *   node scripts/audit-awards-freshness.js --json
 *
 * Exit codes: 0 fresh; 1 stale, OR the date could not be determined (printed
 * as such — an unknown age is not a fresh file, but it is a drift line, not
 * a job crash, so a GitHub API blip never fails the 30 sibling audits).
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help');
const { defaultRunGh, REPO_SLUG } = require('./lib/done-evidence-remote');

const AWARDS_PATH = 'data/awards.json';
/** ~14 months: 12-month annual cycle + 2 months grace for late ceremonies. */
const MAX_AGE_DAYS = 425;

const USAGE = `Usage: node scripts/audit-awards-freshness.js [--json]

Checks that ${AWARDS_PATH} was committed within the last ${MAX_AGE_DAYS} days
(GitHub commits-by-path API). Exit 0 fresh; 1 stale or could not determine.
If it fires, run the annual update: memory/awards-annual-update.md`;

/**
 * Pure decision: how old is the file, and is that acceptable?
 * @param {{ lastTouchedIso: string|null, now?: Date, maxAgeDays?: number }} p
 * @returns {{ status: 'fresh'|'stale'|'unknown', ageDays: number|null, reason: string }}
 */
function decideAwardsFreshness({ lastTouchedIso, now = new Date(), maxAgeDays = MAX_AGE_DAYS }) {
  if (!lastTouchedIso) {
    return { status: 'unknown', ageDays: null, reason: `could not determine the last-touch date of ${AWARDS_PATH}` };
  }
  const t = Date.parse(lastTouchedIso);
  if (!Number.isFinite(t)) {
    return { status: 'unknown', ageDays: null, reason: `unparseable last-touch date ${JSON.stringify(lastTouchedIso)}` };
  }
  const ageDays = Math.floor((now.getTime() - t) / 86400e3);
  if (ageDays > maxAgeDays) {
    return { status: 'stale', ageDays, reason: `${AWARDS_PATH} last touched ${ageDays} days ago (${lastTouchedIso}) — max ${maxAgeDays}. Run the annual awards update: memory/awards-annual-update.md` };
  }
  return { status: 'fresh', ageDays, reason: `${AWARDS_PATH} last touched ${ageDays} days ago (${lastTouchedIso}), within the ${maxAgeDays}-day window` };
}

/**
 * Committer date of the newest commit touching AWARDS_PATH, or null.
 * Injectable runGh (same seam as done-evidence-remote.js).
 */
function fetchLastTouchedIso({ runGh = defaultRunGh, repo = process.env.GITHUB_REPOSITORY || REPO_SLUG } = {}) {
  const out = runGh([
    'api',
    `repos/${repo}/commits?path=${encodeURIComponent(AWARDS_PATH)}&per_page=1`,
    '--jq', '.[0].commit.committer.date',
  ]);
  if (out === null || out === '' || out === 'null') return null;
  return out.trim();
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const json = argv.includes('--json');
  const verdict = decideAwardsFreshness({ lastTouchedIso: fetchLastTouchedIso() });
  if (json) {
    console.log(JSON.stringify({ path: AWARDS_PATH, maxAgeDays: MAX_AGE_DAYS, ...verdict }));
  } else {
    const icon = verdict.status === 'fresh' ? '✅' : verdict.status === 'stale' ? '❌' : '❓';
    console.log(`${icon} awards freshness: ${verdict.status} — ${verdict.reason}`);
  }
  process.exit(verdict.status === 'fresh' ? 0 : 1);
}

module.exports = { decideAwardsFreshness, fetchLastTouchedIso, AWARDS_PATH, MAX_AGE_DAYS };

if (require.main === module) main();
