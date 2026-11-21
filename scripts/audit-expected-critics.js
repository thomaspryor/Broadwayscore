#!/usr/bin/env node
'use strict';

/**
 * audit-expected-critics.js (BRO-7166): which usual critics have no review of a
 * recent opening, and why.
 *
 *   node scripts/audit-expected-critics.js                       # openings 72h..42d old, all markets
 *   node scripts/audit-expected-critics.js --since=2026-09-08    # opening-date range instead
 *   node scripts/audit-expected-critics.js --market=west-end --json
 *   node scripts/audit-expected-critics.js --cells=show::outlet,show::outlet   # named cells, expected or not
 *   node scripts/audit-expected-critics.js --ack=show::outlet --note="checked outlet listing 2026-11-08, no review"
 *
 * Status per cell: live (review in reviews.json, alias- and -london-aware),
 * not-reviewed (acked in data/audit/t1-coverage-ack.json with evidence),
 * not-expected (registry coverageExpectation none, active), missing.
 * Read-only except --ack. Exit 0 always (advisory, BRO-2123).
 */

const fs = require('fs');
const path = require('path');
const { findExpectedCriticGaps, statusForCells } = require('./lib/expected-critics');
const { STANDING_MARKETS } = require('./audit-standing-coverage');
const { loadAcks, addAck, saveAcks } = require('./lib/t1-scoreboard');
const recovery = require('./lib/expected-critics-recovery');

const ROOT = path.join(__dirname, '..');
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function main() {
  const since = arg('since');
  const until = arg('until');
  const market = arg('market');
  for (const [k, v] of [['since', since], ['until', until]]) {
    if (v !== undefined && !DATE_RE.test(v)) { console.error(`--${k} must be YYYY-MM-DD`); process.exit(2); }
  }
  if (market && !STANDING_MARKETS.includes(market)) { console.error(`--market must be one of ${STANDING_MARKETS.join(', ')}`); process.exit(2); }

  const nowMs = Date.now();
  if (arg('ack')) {
    const key = arg('ack');
    const note = arg('note');
    if (!/^[a-z0-9-]+::[a-z0-9-]+$/.test(key)) { console.error('--ack must be show-id::outlet-id'); process.exit(2); }
    if (!note || note.trim().length < 15) { console.error('--note with the evidence (>=15 chars) is required'); process.exit(2); }
    const acks = loadAcks();
    if (acks.some((a) => a.key === key)) { console.log(`${key}: already acked`); return; }
    saveAcks(addAck(acks, key, note.trim(), new Date(nowMs).toISOString()));
    console.log(`${key}: acked as not reviewed`);
    return;
  }

  const shows = readJson('data/shows.json').shows;
  const reviews = readJson('data/reviews.json').reviews;
  const outlets = readJson('data/outlet-registry.json').outlets;
  const state = recovery.loadRecoveryState();
  const acks = recovery.mergedAcks(loadAcks(), state); // BRO-7312: auto-acks from the recovery count

  if (arg('cells')) {
    const rows = statusForCells({ keys: arg('cells').split(',').filter(Boolean), shows, reviews, outlets, acks, nowMs });
    if (flag('json')) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) console.log(`${r.status.padEnd(13)} ${r.key}${r.expected === false ? ' (not in expected set)' : ''}${r.ackNote ? `  [${r.ackNote}]` : ''}`);
    return;
  }

  const rows = findExpectedCriticGaps({ shows, reviews, outlets, acks, nowMs, since, until, market });
  if (flag('json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  const open = rows.filter((r) => r.status !== 'live');
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log(`Expected critics: ${rows.length} cells, ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  let cur = null;
  for (const r of open) {
    if (r.showId !== cur) { cur = r.showId; console.log(`\n${r.title} [${r.category}] opened ${r.openingDate} (${r.ageDays}d)`); }
    const rec = r.status === 'missing' ? recovery.ownerVisibility(r, state, nowMs) : null;
    const recText = rec ? `  {recovery: ${rec.phase}/${rec.reason}${rec.visible ? ', owner-visible' : ''}}` : '';
    console.log(`  ${r.status.padEnd(13)} ${r.outletId}${r.ackNote ? `  [${r.ackNote}]` : ''}${recText}`);
  }
}

main();
