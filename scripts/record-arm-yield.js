#!/usr/bin/env node
'use strict';

/**
 * record-arm-yield.js — writes the per-arm daily output ledger that
 * check-arm-yield.js judges (card #647, gap (a): "no per-arm output ledger,
 * so 'this arm found N reviews today' is not recorded anywhere queryable
 * across runs").
 *
 * Ledger: data/audit/arm-yield-ledger.jsonl, one JSON object per line:
 *   {"arm":"outlet:nysr","date":"2026-07-30","itemsFound":2,"kind":"outlet","recordedAt":"..."}
 *
 * Both arm kinds are derived from sources that already exist, which is what
 * makes the ledger BACKFILLABLE — the detector could be replayed against the
 * 2026-07-19..07-30 orchestrator outage the day it shipped, instead of having
 * to accumulate a month of history before it could catch anything:
 *   · outlet arms   → review-text files' textFetchedAt/classifiedAt day
 *   · workflow arms → `gh run list` conclusions per day
 *
 * ── The one rule this script must never break ────────────────────────────
 * NEVER write a zero for a day it could not actually observe. A fabricated
 * zero is indistinguishable from a real one downstream, and would turn this
 * detector into a generator of false "arm is dead" alerts. Every path that
 * cannot see a day (gh unavailable, run list truncated before that day,
 * review-texts checkout missing) SKIPS the day, leaving it unobserved —
 * arm-yield.js treats a long unobserved stretch as "the detector is blind",
 * which is a different and honest alarm.
 *
 * Usage:
 *   node scripts/record-arm-yield.js                      # today (UTC)
 *   node scripts/record-arm-yield.js --date=2026-07-30
 *   node scripts/record-arm-yield.js --backfill-days=60
 *   node scripts/record-arm-yield.js --arms=outlet:nysr --backfill-days=30
 *   node scripts/record-arm-yield.js --dry-run            # print, write nothing
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const { selectArms } = require('./lib/arm-registry');
const { dedupeEntries, MS_PER_DAY, toDayKey, todayKey } = require('./lib/arm-yield');
const { listShowDirs } = require('./lib/list-show-dirs');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_LEDGER = path.join(REPO_ROOT, 'data', 'audit', 'arm-yield-ledger.jsonl');
const DEFAULT_REVIEW_TEXTS = path.join(REPO_ROOT, 'data', 'review-texts');
/** Keep ~6 months: long enough to hold a monthly arm's baseline window. */
const RETENTION_DAYS = 190;

const USAGE = `record-arm-yield.js — record per-arm daily yield into the cross-run ledger

Options:
  --date=YYYY-MM-DD     Record this single day (default: today, UTC)
  --backfill-days=N     Record the N days ending at --date (default 1)
  --arms=id,id          Only these registry arm ids (default: all)
  --ledger=PATH         Ledger file (default data/audit/arm-yield-ledger.jsonl)
  --review-texts=PATH   review-texts dir (default data/review-texts)
  --dry-run             Print what would be recorded; write nothing
  --help                This message

Never writes a zero for a day it could not observe — unobservable days are
skipped so the detector can tell "arm produced nothing" from "we couldn't look".`;

function parseArgs(argv) {
  const get = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  return {
    date: get('date', todayKey()),
    backfillDays: Math.max(1, parseInt(get('backfill-days', '1'), 10) || 1),
    arms: get('arms', null),
    ledger: get('ledger', DEFAULT_LEDGER),
    reviewTexts: get('review-texts', DEFAULT_REVIEW_TEXTS),
    dryRun: argv.includes('--dry-run'),
  };
}

/** The `days` calendar days ending at `endDay`, ascending. */
function dayRange(endDay, days) {
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(toDayKey(end - i * MS_PER_DAY));
  return out;
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * outlet arms: count review-text files whose fetch/classify stamp lands on each
 * requested day. One filesystem pass covers every outlet arm and every day.
 *
 * @returns {Map<string, Map<string, number>>} outletId → day → count
 */
function collectOutletYield(reviewTextsDir, days) {
  const wantedDays = new Set(days);
  const byOutlet = new Map();
  if (!fs.existsSync(reviewTextsDir)) return byOutlet;

  const showDirs = listShowDirs(reviewTextsDir).filter((name) => {
    if (name.startsWith('_') || name.startsWith('.')) return false;
    try {
      return fs.statSync(path.join(reviewTextsDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    let files;
    try {
      files = fs.readdirSync(showPath).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch {
      continue;
    }
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showPath, file), 'utf8'));
      } catch {
        continue;
      }
      // textFetchedAt is when collection actually produced this item; fall back
      // to classifiedAt for files written before that field existed.
      const stamp = data.textFetchedAt || data.classifiedAt;
      if (!stamp) continue;
      const day = String(stamp).slice(0, 10);
      if (!wantedDays.has(day)) continue;
      const outletId = data.outletId;
      if (!outletId) continue;
      if (!byOutlet.has(outletId)) byOutlet.set(outletId, new Map());
      const dayMap = byOutlet.get(outletId);
      dayMap.set(day, (dayMap.get(day) || 0) + 1);
    }
  }
  return byOutlet;
}

/**
 * workflow arms: successful runs per day, from `gh run list`.
 *
 * Returns `null` (NOT an empty map) whenever gh is unusable, so the caller
 * skips the arm entirely rather than recording fabricated zeroes.
 *
 * `observableFrom` is the oldest day the returned page can speak for: if the
 * API page is full and its oldest run is newer than the requested range, every
 * day before that run is truncation, not silence, and must not be recorded.
 *
 * @returns {{counts: Map<string, number>, observableFrom: string}|null}
 */
function collectWorkflowYield(workflowFile, days) {
  const limit = 200;
  let raw;
  try {
    raw = execFileSync(
      'gh',
      ['run', 'list', '--workflow', workflowFile, '--limit', String(limit), '--json', 'createdAt,conclusion,event'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
    );
  } catch (e) {
    console.warn(`  ! gh run list failed for ${workflowFile}: ${(e.message || '').split('\n')[0]}`);
    return null;
  }

  let runs;
  try {
    runs = JSON.parse(raw);
  } catch {
    console.warn(`  ! unparseable gh output for ${workflowFile}`);
    return null;
  }
  if (!Array.isArray(runs)) return null;

  const counts = new Map();
  let oldestSeen = null;
  for (const run of runs) {
    const day = String(run.createdAt || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (oldestSeen === null || day < oldestSeen) oldestSeen = day;
    // SCHEDULED successes only, for two reasons.
    //
    // Only `success` counts as yield: cancelled (the orchestrator at its
    // 360min cap) and failure (sweep-we-aggregators) both produced nothing.
    // That is the entire point — the audit's dead arms were dead in exactly
    // those two ways, and neither is a `failure` the notify chain pages on.
    //
    // Only `schedule` counts, because check-cron-health.yml SELF-HEALS a stale
    // cron by redispatching it. Those manual runs frequently succeed even while
    // the schedule stays broken (the orchestrator's 07-21 and 07-30 dispatch
    // successes sat inside a fortnight of cancelled scheduled runs). Counting
    // them would let the repair attempt keep resetting the detector daily and
    // hide the outage it was dispatched to fix.
    if (run.conclusion === 'success' && run.event === 'schedule') {
      counts.set(day, (counts.get(day) || 0) + 1);
    }
  }

  // A short page proves history back to the beginning; a full page only proves
  // history back to its oldest run.
  const observableFrom = runs.length >= limit && oldestSeen ? oldestSeen : days[0];
  return { counts, observableFrom };
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(process.argv.slice(2));
  const { arms, unknown } = selectArms(args.arms);
  if (unknown.length) {
    console.error(`Unknown arm id(s): ${unknown.join(', ')}`);
    return 1;
  }
  const days = dayRange(args.date, args.backfillDays);
  const recordedAt = new Date().toISOString();
  console.log(
    `Recording yield for ${arms.length} arm(s) over ${days.length} day(s): ${days[0]} → ${days[days.length - 1]}`
  );

  const fresh = [];
  const outletArms = arms.filter((a) => a.kind === 'outlet');
  if (outletArms.length) {
    if (!fs.existsSync(args.reviewTexts)) {
      // Skipping (not zero-filling) keeps a missing private-repo checkout from
      // manufacturing a corpus-wide "every outlet is dead" alert.
      console.warn(`  ! review-texts missing at ${args.reviewTexts} — skipping ${outletArms.length} outlet arm(s)`);
    } else {
      const byOutlet = collectOutletYield(args.reviewTexts, days);
      for (const arm of outletArms) {
        for (const day of days) {
          const itemsFound = (arm.outletIds || []).reduce(
            (sum, outletId) => sum + ((byOutlet.get(outletId) || new Map()).get(day) || 0),
            0
          );
          fresh.push({ arm: arm.id, date: day, itemsFound, kind: 'outlet', recordedAt });
        }
      }
    }
  }

  for (const arm of arms.filter((a) => a.kind === 'workflow')) {
    const result = collectWorkflowYield(arm.workflow, days);
    if (!result) {
      console.warn(`  ! ${arm.id}: not observable this run — skipped (no rows written)`);
      continue;
    }
    let skipped = 0;
    for (const day of days) {
      if (day < result.observableFrom) {
        skipped += 1;
        continue;
      }
      fresh.push({ arm: arm.id, date: day, itemsFound: result.counts.get(day) || 0, kind: 'workflow', recordedAt });
    }
    if (skipped) {
      console.warn(
        `  ! ${arm.id}: ${skipped} day(s) before ${result.observableFrom} not covered by the run-list page — skipped`
      );
    }
  }

  const summary = {};
  for (const row of fresh) summary[row.arm] = (summary[row.arm] || 0) + row.itemsFound;
  for (const arm of arms) {
    const rows = fresh.filter((r) => r.arm === arm.id).length;
    if (!rows) continue;
    console.log(`  ${arm.id}: ${rows} day(s), ${summary[arm.id] || 0} item(s)`);
  }

  if (args.dryRun) {
    console.log(`[dry-run] ${fresh.length} row(s) not written`);
    return 0;
  }
  if (!fresh.length) {
    console.log('Nothing observable to record.');
    return 0;
  }

  // Re-recording a day REPLACES it (dedupeEntries keeps the last write), so a
  // backfill re-run is idempotent instead of doubling every count.
  const merged = dedupeEntries([...readLedger(args.ledger), ...fresh]);
  const cutoff = toDayKey(Date.now() - RETENTION_DAYS * MS_PER_DAY);
  const retained = merged.filter((row) => row.date >= cutoff);

  fs.mkdirSync(path.dirname(args.ledger), { recursive: true });
  const tmp = `${args.ledger}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, retained.map((row) => JSON.stringify(row)).join('\n') + '\n');
  fs.renameSync(tmp, args.ledger);
  console.log(
    `Wrote ${retained.length} row(s) to ${path.relative(REPO_ROOT, args.ledger)} (${merged.length - retained.length} pruned older than ${RETENTION_DAYS}d)`
  );
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { collectOutletYield, collectWorkflowYield, dayRange, readLedger };
