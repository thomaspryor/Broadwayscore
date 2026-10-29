#!/usr/bin/env node
'use strict';

/**
 * record-claude-session-cost.js (BRO-5671): fill data/audit/claude-session-cost.jsonl.
 *
 * Needs a cloud session with the claude-code-remote `get_session` tool (Actions cannot call it):
 *   1. node scripts/record-claude-session-cost.js --list [--hours=24]
 *        prints JSON: [{ session, cards }] for sessions with a Claude-Session trailer on
 *        origin/main commits in the window (git fetch origin main first).
 *   2. call get_session for each id; save the raw results as a JSON array to a file.
 *   3. node scripts/record-claude-session-cost.js --from-json=<file> [--date=YYYY-MM-DD] [--hours=24]
 *        appends one row per session { date, session, model, origin, costUsd, cards }, cards taken
 *        from the same git window. Re-running the same day replaces that day's row.
 *   4. commit the ledger and land it like any data change.
 *
 * Self-record at wrap-up (BRO-6504): call get_session with no session_id (it describes the calling session),
 * save the result to a file, run `--from-json=<file> --cards=BRO-N` and commit the ledger with the work.
 *
 * A session that is not in the git window is still recorded (cards: []) so its cost is not lost.
 * Exit 0 ok, 1 a result could not be read (the others are still written), 2 usage.
 */

const fs = require('fs');
const path = require('path');
const C = require('./lib/claude-session-cost.js');
const { appendRows } = require('./lib/claude-session-cost-writer.js');

const REPO = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const hours = Number(args.hours || 24);
  if (!Number.isFinite(hours) || hours <= 0) { console.error('--hours must be a positive number'); return 2; }
  const ref = args.ref || 'origin/main';
  if (args.list) {
    const sessions = C.landedSessions({ cwd: REPO, hours, ref });
    console.log(JSON.stringify([...sessions].map(([session, e]) => ({ session, cards: [...e.cards].sort() })), null, 2));
    return 0;
  }
  if (!args['from-json']) {
    console.error('Usage: record-claude-session-cost.js --list [--hours=24] | --from-json=<file> [--date=YYYY-MM-DD] [--hours=24] [--cards=BRO-N,...] [--dry-run]');
    return 2;
  }
  const date = args.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('--date must be YYYY-MM-DD'); return 2; }
  let results = JSON.parse(fs.readFileSync(args['from-json'], 'utf8'));
  if (!Array.isArray(results)) results = [results];
  // --cards: the session's own card ids, for a session that has not landed a commit yet (BRO-6504 wrap-up self-record).
  const extraCards = typeof args.cards === 'string' ? args.cards.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : [];
  if (args.cards !== undefined && (!extraCards.length || extraCards.some((x) => !/^BRO-\d+$/.test(x)))) { console.error('--cards must be BRO-N[,BRO-N...]'); return 2; }
  if (extraCards.length && results.length !== 1) { console.error('--cards only applies to a single session result'); return 2; }
  const landed = C.landedSessions({ cwd: REPO, hours, ref });
  const rows = [];
  let failed = 0;
  for (const res of results) {
    const p = C.parseGetSession(res);
    if (p.error) { failed += 1; console.error(`skip ${p.session || '?'}: ${p.error}`); continue; }
    const e = landed.get(p.session);
    const cards = [...new Set([...(e ? e.cards : []), ...extraCards])].sort();
    rows.push({ date, session: p.session, model: p.model, origin: p.origin, costUsd: p.costUsd, cards });
  }
  if (args['dry-run']) { rows.forEach((r) => console.log(JSON.stringify(r))); return failed ? 1 : 0; }
  const r = rows.length ? appendRows(rows, { file: C.ledgerPath(REPO) }) : { written: 0, replaced: 0 };
  console.log(`${C.LEDGER_REL}: ${r.written} row(s) written (${r.replaced} replaced same-day rows), ${failed} skipped`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { parseArgs };
