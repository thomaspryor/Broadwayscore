#!/usr/bin/env node
/**
 * BRO-3022: seed data/audit/breaker-transitions.jsonl from the commit history
 * of the breaker state files, so Sprint 3 (BRO-3011) has a week of history the
 * day it runs instead of starting from an empty file.
 *
 * WHY THIS EXISTS, given the card deliberately rejected the history channel.
 * It rejected it as the LIVE source, and rightly: BRO-2960 is moving breaker
 * state off the commit channel, and per BRO-2951 those commits are lost most
 * hours — that same step's own evidence was 9 lost pushes in 12 runs. So this
 * is not a substitute for the recorder in scripts/lib/breaker-transitions.js;
 * it is a one-shot seed for the window BEFORE the recorder existed. Every row
 * it writes is stamped source:'history-backfill' precisely so a reader can
 * treat those days as a FLOOR and never as a complete week.
 *
 * HOW. `trippedAt` in each state file is preserved across the hourly re-checks
 * of a single day and re-stamped only on a fresh trip, so a change in its value
 * is exactly one trip. Walking the file's commits oldest-first and emitting a
 * row on each change reconstructs the trip days. The row's `ts` IS the
 * trippedAt value, which makes the whole backfill deterministic and therefore
 * idempotent: re-running it produces byte-identical rows, and rows already
 * present (matched on (ts, conditionKey), the same key
 * scripts/lib/merge-breaker-transitions.js dedupes on) are skipped.
 *
 * Rows are chain-neutral (prevTs: null). A backfilled row carries an OLD ts but
 * is appended after rows newer than itself, so deriving a chain link from the
 * file would record one that runs backwards; findChainBreaks() skips rows with
 * no prevTs, so these never manufacture a false gap.
 *
 * Usage:
 *   node scripts/backfill-breaker-transitions.js --dry-run   # print, write nothing
 *   node scripts/backfill-breaker-transitions.js             # append missing rows
 *   node scripts/backfill-breaker-transitions.js --since=90.days
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const {
  DEFAULT_PATH,
  loadTransitions,
  appendTransition,
  reconstructTransitions,
  daysTripped,
} = require('./lib/breaker-transitions');

const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`backfill-breaker-transitions.js — seed the transition ledger from state-file history

  node scripts/backfill-breaker-transitions.js --dry-run    print the rows, write nothing
  node scripts/backfill-breaker-transitions.js              append the rows that are missing
  node scripts/backfill-breaker-transitions.js --since=90.days

Idempotent: rows are keyed on (ts, conditionKey) and existing ones are skipped.
Every row is stamped source:'history-backfill' — those days are a FLOOR, not a
complete week, because the commit channel they come from is lossy (BRO-2951).
`);
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
const SINCE = (process.argv.find((a) => a.startsWith('--since=')) || '--since=120.days').split('=')[1];
const REPO_ROOT = path.join(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Commits touching one path, OLDEST first. */
function commitsFor(relPath) {
  const out = git(['log', `--since=${SINCE}`, '--reverse', '--format=%H', '--', relPath]).trim();
  return out ? out.split('\n') : [];
}

function blobAt(sha, relPath) {
  try {
    return JSON.parse(git(['show', `${sha}:${relPath}`]));
  } catch {
    return null; // absent at that commit, or unparseable — skip it
  }
}

function collectSd() {
  const rel = 'data/audit/sd-circuit-breaker.json';
  const observations = [];
  for (const sha of commitsFor(rel)) {
    const state = blobAt(sha, rel);
    if (!state) continue;
    observations.push({ trippedAt: state.trippedAt || null, units: state.dayCredits ?? null, ceiling: state.ceiling ?? null });
  }
  return reconstructTransitions(observations, 'sd-circuit-breaker');
}

function collectBd() {
  const rel = 'data/audit/bd-circuit-breaker.json';
  const byZone = new Map();
  for (const sha of commitsFor(rel)) {
    const state = blobAt(sha, rel);
    if (!state || !state.zones) continue;
    for (const [zone, z] of Object.entries(state.zones)) {
      if (!byZone.has(zone)) byZone.set(zone, []);
      byZone.get(zone).push({ trippedAt: (z && z.trippedAt) || null, units: (z && z.billedReqs) ?? null, ceiling: (z && z.ceiling) ?? null });
    }
  }
  const rows = [];
  for (const [zone, observations] of byZone) {
    rows.push(...reconstructTransitions(observations, `bd-circuit-breaker-${zone}`));
  }
  return rows;
}

function main() {
  const candidates = [...collectSd(), ...collectBd()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // Dedupe WITHIN the batch as well as against the file. A state file whose
  // trippedAt reverts to an earlier value (A -> null -> A, plausible when a
  // commit is lost per BRO-2951) reconstructs as two rows with an identical ts,
  // which would break the (ts, conditionKey) uniqueness that
  // merge-breaker-transitions.js dedupes on and this script's own idempotency
  // claim rests on (ship-check finding, 2026-09-08).
  const seen = new Set(loadTransitions(DEFAULT_PATH).map((r) => `${r.ts} ${r.conditionKey}`));
  const missing = candidates.filter((r) => {
    const key = `${r.ts} ${r.conditionKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Reconstructed ${candidates.length} trip transition(s) from state-file history (--since=${SINCE}); ${candidates.length - missing.length} already recorded, ${missing.length} to add.`);

  for (const row of missing) {
    if (DRY_RUN) {
      console.log(`  + ${row.ts} ${row.conditionKey} ${row.from}->${row.to} day=${row.day}`);
      continue;
    }
    appendTransition({ ...row, source: 'history-backfill', prevTs: null, ledgerPath: DEFAULT_PATH });
  }

  if (DRY_RUN) {
    console.log('--dry-run: nothing written');
  } else if (missing.length) {
    console.log(`Appended ${missing.length} row(s) to ${DEFAULT_PATH}`);
  }

  // Report what Sprint 3 would now see, from the rows that exist after this run
  // (or would exist, under --dry-run, from the reconstruction itself).
  const rows = DRY_RUN
    ? candidates.map((r) => ({ ...r, source: 'history-backfill', prevTs: null }))
    : loadTransitions(DEFAULT_PATH);
  const keys = [...new Set(rows.map((r) => r.conditionKey))].sort();
  for (const conditionKey of keys) {
    const { days, dayList, lowerBound } = daysTripped(rows, { conditionKey });
    console.log(`  ${conditionKey}: ${days} trip day(s)${lowerBound ? ' (LOWER BOUND — chain gap detected)' : ''}`);
    console.log(`    ${dayList.join(' ')}`);
  }
}

main();
