#!/usr/bin/env node
/**
 * check-linear-drain-throughput.js — BRO-4135. The RECHECK command for
 * BRO-3913's own goal: "15+ Done/day sustained", checkable from
 * 2026-09-27 onward.
 *
 *   node scripts/check-linear-drain-throughput.js --min-done-per-day 15
 *
 * Exit codes: 0 = at/above the bar, 1 = below the bar, 2 = bad CLI usage
 * (missing/invalid --min-done-per-day), 3 = could not be measured (no
 * snapshot and no live fetch succeeded) — matches acceptance-check-core.js's
 * own exit-3 "unverifiable, not failed" convention (ship-check/Codex
 * finding, BRO-4135), so this command reads correctly if it is ever run
 * through that same sandboxed runner (autonomous-acceptance-recheck.js) —
 * exit 2 there is an ordinary failure, not the unverifiable case.
 *
 * DOES NOT re-fetch Linear on every run. scripts/lib/linear-drain-
 * throughput.js's own header explicitly rejected a second live query for
 * this exact number: send-morning-digest.js already computes it every
 * morning (BRO-3923 R6) and, as of BRO-4135, persists it to
 * data/audit/linear-drain-throughput-snapshot.json (gitignored, Mac-local —
 * that digest is launchd-scheduled, not CI). This script reads that
 * snapshot when it is fresh enough (SNAPSHOT_MAX_AGE_MS) and only falls
 * back to its own live fetch (same fetchInflowCounts/graphql call the
 * digest itself makes) when the snapshot is missing or stale — e.g. run
 * from a machine that never ran the digest, or the digest itself has been
 * failing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { doneRatePerDay } = require('./lib/linear-drain-throughput.js');

const REPO = path.join(__dirname, '..');
const SNAPSHOT_PATH = path.join(REPO, 'data', 'audit', 'linear-drain-throughput-snapshot.json');
// A bit over a day — the digest runs once/day (~7:30am ET); this tolerates
// one missed/late run before falling back to a live fetch, same spirit as
// linear-drain-throughput.js's own HEARTBEAT_STALE_MS staleness convention.
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 60 * 1000;

const USAGE = `check-linear-drain-throughput.js — RECHECK command for BRO-3913's
"15+ Done/day sustained" goal (BRO-4135).

Usage:
  node scripts/check-linear-drain-throughput.js --min-done-per-day <N>
  node scripts/check-linear-drain-throughput.js --min-done-per-day 15 --live

  --min-done-per-day N  required, positive number — the bar to check against
  --live                skip the snapshot, always fetch fresh from Linear
  --help/-h             show this message, do nothing else

Exit codes: 0 = at/above the bar, 1 = below the bar, 2 = bad usage, 3 = could not be measured.`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true;
    else { a[k] = n; i++; }
  }
  return a;
}

/**
 * PURE. ok:true at/above the bar, ok:false below it, ok:null when
 * donePerDay itself is not a measurable number (nothing to compare).
 */
function evaluateThroughputGate(donePerDay, minDonePerDay) {
  if (!Number.isFinite(donePerDay)) {
    return { ok: null, reason: 'donePerDay is not a measurable number (no data)' };
  }
  if (!Number.isFinite(minDonePerDay) || minDonePerDay <= 0) {
    return { ok: null, reason: `minDonePerDay must be a positive number, got ${JSON.stringify(minDonePerDay)}` };
  }
  if (donePerDay >= minDonePerDay) {
    return { ok: true, reason: `${donePerDay}/day >= bar ${minDonePerDay}/day` };
  }
  return { ok: false, reason: `${donePerDay}/day < bar ${minDonePerDay}/day` };
}

function readFreshSnapshot(snapshotPath = SNAPSHOT_PATH, nowMs = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8');
  } catch {
    return null;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (e) {
    console.error(`[check-linear-drain-throughput] WARN snapshot is not valid JSON, ignoring: ${e.message}`);
    return null;
  }
  const computedMs = Date.parse(snapshot.computedAt);
  if (!Number.isFinite(computedMs) || nowMs - computedMs > SNAPSHOT_MAX_AGE_MS) {
    console.error(`[check-linear-drain-throughput] snapshot is stale or unparseable (computedAt=${snapshot.computedAt}), falling back to a live fetch`);
    return null;
  }
  // ship-check/Codex finding (BRO-4135): a digest run that itself failed to
  // measure donePerDay still writes a fresh timestamp (send-morning-digest.js
  // catches its own fetch error and records `donePerDay: null` rather than
  // skipping the write). Treating that as "fresh" would silently block a
  // live fetch for up to SNAPSHOT_MAX_AGE_MS even after Linear recovers —
  // a snapshot is only useful here if it actually carries a number.
  if (!Number.isFinite(snapshot.donePerDay)) {
    console.error('[check-linear-drain-throughput] snapshot is fresh but carries no donePerDay (the digest itself could not measure it), falling back to a live fetch');
    return null;
  }
  return snapshot;
}

async function fetchLiveDonePerDay() {
  const { graphql } = require('./lib/linear-client.js');
  const { fetchInflowCounts } = require('./lib/backlog-inflow-ratio.js');
  const counts = await fetchInflowCounts({ graphql, now: new Date() });
  const truncated = Array.isArray(counts.truncatedCounts) && counts.truncatedCounts.includes('completed');
  return doneRatePerDay(counts.completed, counts.windowDays, { truncated });
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const args = parseArgs(argv);
  const minDonePerDay = Number(args['min-done-per-day']);
  if (!Number.isFinite(minDonePerDay) || minDonePerDay <= 0) {
    console.error(`--min-done-per-day must be a positive number, got ${JSON.stringify(args['min-done-per-day'])}\n\n${USAGE}`);
    return 2;
  }

  let donePerDay = null;
  const snapshot = args.live ? null : readFreshSnapshot(SNAPSHOT_PATH);
  if (snapshot) {
    donePerDay = Number.isFinite(snapshot.donePerDay) ? snapshot.donePerDay : null;
    console.error(`[check-linear-drain-throughput] using snapshot from ${snapshot.computedAt}`);
  } else {
    try {
      donePerDay = await fetchLiveDonePerDay();
      console.error('[check-linear-drain-throughput] used a live Linear fetch (no fresh snapshot)');
    } catch (e) {
      console.error(`[check-linear-drain-throughput] live fetch failed: ${e.message}`);
      donePerDay = null;
    }
  }

  const verdict = evaluateThroughputGate(donePerDay, minDonePerDay);
  if (verdict.ok === null) {
    console.error(`[check-linear-drain-throughput] UNVERIFIABLE: ${verdict.reason}`);
    return 3;
  }
  if (verdict.ok) {
    console.log(`[check-linear-drain-throughput] PASS: ${verdict.reason}`);
    return 0;
  }
  console.error(`[check-linear-drain-throughput] FAIL: ${verdict.reason}`);
  return 1;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(err => {
    // An unexpected crash mid-fetch is "no answer", not "definitely below
    // the bar" — exit 3, the same unverifiable code as the handled
    // live-fetch-failure path above, not exit 1 (fail) or exit 2 (usage).
    console.error(`[check-linear-drain-throughput] fatal: ${err.message}`);
    process.exitCode = 3;
  });
}

module.exports = { parseArgs, evaluateThroughputGate, readFreshSnapshot, USAGE, SNAPSHOT_PATH, SNAPSHOT_MAX_AGE_MS };
