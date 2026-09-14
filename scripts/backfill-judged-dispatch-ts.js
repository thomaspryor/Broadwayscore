#!/usr/bin/env node
'use strict';
/**
 * One-time backfill of `judgedDispatchTs` onto existing outcome rows (BRO-3321).
 *
 * WHY THIS EXISTS
 * Outcome rows (card-pass/card-fail) are written by a reconciliation pass that
 * can run long after the dispatch it judges, but every writer stamps `ts` at
 * append time. Consumers that age a trailing window therefore measured "when we
 * got around to looking" instead of "when the work happened". On 2026-09-14 the
 * morning digest reconciled three dispatches from 2026-08-14 — 31 days stale —
 * and the 7-day window read them as three fresh failures, emailing the owner
 * "Auto-fix loop is DEAD: 0 of 3 job(s) succeeded in the last 7d" while three
 * genuinely new dispatches were spawning and reaching job-done in the same hour.
 *
 * The code fix makes every FUTURE outcome row carry `judgedDispatchTs`, and
 * consumers fall back to `ts` for rows written before the field existed. That
 * fallback is correct and deliberate — but it also means the rows already on
 * disk keep producing the false banner until they age out, which for the
 * 2026-09-14 rows is a full week of the owner being told his fleet is dead.
 * This backfills what the reconciler WOULD have written, so the alarm tells the
 * truth today rather than next week.
 *
 * THE RULE — deterministic, and the same correlation reconciliation itself uses:
 * an outcome row is matched to the LATEST 'auto-dispatch'/'drain-dispatch' row
 * that shares its cardId AND contentHash and occurs at or before it. That pair
 * is exactly what classifyDispatches resolved when it emitted the outcome. An
 * outcome with no such dispatch is LEFT ALONE — guessing would be worse than
 * the existing `ts` fallback, which is at least honest about being a write time.
 *
 * Idempotent: a row that already has `judgedDispatchTs` is never rewritten.
 * Dry-run by default; --apply writes, after saving a .bak alongside each file.
 *
 *   node scripts/backfill-judged-dispatch-ts.js            # report only
 *   node scripts/backfill-judged-dispatch-ts.js --apply    # write
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const AUDIT_DIR = path.join(REPO, 'data', 'audit');

// Each ledger with its dispatch-event name. These are per-machine and
// gitignored, so this runs where they actually live, not in CI.
const LEDGERS = [
  { file: 'digest-autofix-ledger.jsonl', dispatchEvent: 'auto-dispatch' },
  { file: 'backlog-drain-ledger.jsonl', dispatchEvent: 'drain-dispatch' },
  { file: 'linear-drain-parked-ledger.jsonl', dispatchEvent: 'drain-dispatch' },
];

const OUTCOME_EVENTS = new Set(['card-pass', 'card-fail', 'card-stranded']);

// Dispatch rows key off taskId, outcome rows off cardId — the same asymmetry
// classifyDispatches bridges with its cardIdOf/taskIdOf accessors.
function keyOf(row) {
  const id = row.cardId != null ? row.cardId : row.taskId;
  return `${String(id)}\u0000${String(row.contentHash)}`;
}

function backfillRows(rows, dispatchEvent) {
  // Dispatches seen so far, newest-last per key, so "latest at or before" is
  // just the last one recorded when we reach the outcome. Ledgers are
  // append-only and chronological by construction.
  const latestDispatchTs = new Map();
  let stamped = 0;
  let alreadyStamped = 0;
  let unmatched = 0;

  const out = rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    if (row.event === dispatchEvent) {
      if (row.contentHash != null && row.ts) latestDispatchTs.set(keyOf(row), row.ts);
      return row;
    }
    if (!OUTCOME_EVENTS.has(row.event)) return row;
    if (row.judgedDispatchTs) { alreadyStamped++; return row; }
    const ts = latestDispatchTs.get(keyOf(row));
    if (!ts) { unmatched++; return row; }
    stamped++;
    return { ...row, judgedDispatchTs: ts };
  });

  return { out, stamped, alreadyStamped, unmatched };
}

function main() {
  const apply = process.argv.includes('--apply');
  let totalStamped = 0;

  for (const { file, dispatchEvent } of LEDGERS) {
    const abs = path.join(AUDIT_DIR, file);
    if (!fs.existsSync(abs)) { console.log(`— ${file}: absent on this machine, skipped`); continue; }

    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split('\n');
    const rows = [];
    const bad = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { bad.push(t); }
    }
    if (bad.length) {
      // Refuse rather than silently drop: rewriting a file we could not fully
      // parse would destroy whatever those lines were.
      console.error(`✗ ${file}: ${bad.length} unparseable line(s) — refusing to rewrite this file`);
      continue;
    }

    const { out, stamped, alreadyStamped, unmatched } = backfillRows(rows, dispatchEvent);
    totalStamped += stamped;
    console.log(
      `${stamped ? '✎' : '·'} ${file}: ${rows.length} row(s) — ${stamped} to stamp, `
      + `${alreadyStamped} already stamped, ${unmatched} with no matching dispatch (left as-is)`
    );

    if (apply && stamped) {
      fs.copyFileSync(abs, `${abs}.bak`);
      fs.writeFileSync(abs, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
      console.log(`  wrote ${file} (backup at ${file}.bak)`);
    }
  }

  if (!apply) console.log(`\nDRY RUN — ${totalStamped} row(s) would be stamped. Re-run with --apply to write.`);
}

if (require.main === module) main();

module.exports = { backfillRows };
