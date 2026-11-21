#!/usr/bin/env node
/**
 * rebuild-awards-from-precursors.js — clear stale precursor wins from
 * awards.json, then re-run enrichment from a clean slate.
 *
 * Why this exists: enrich-awards-with-precursors.js is ADDITIVE — it never
 * removes existing wins. After fixing miscredits in data/precursors/*.json
 * (e.g. by adopting year-page-scraped data), the old wrong wins linger
 * because enrich only appends. This wrapper:
 *   1. Snapshots awards.json (rollback backup)
 *   2. Clears wins + winnerNames from every show's dramadesk/OCC/DL/lortel fields
 *      (nominatedFor is preserved — it's a different lifecycle)
 *   3. Shells out to enrich-awards-with-precursors.js to repopulate
 *   4. Refuses to run during Tony-ceremony window unless --ack-tony-window=YYYY
 *
 * Coverage gate runs INSIDE enrich (its existing 5%-shrink guard on precursor
 * loads). We additionally check post-rebuild that no ceremony lost
 * categories beyond a threshold.
 *
 * Usage:
 *   node scripts/rebuild-awards-from-precursors.js --dry-run
 *   node scripts/rebuild-awards-from-precursors.js --write
 *   node scripts/rebuild-awards-from-precursors.js --write --ack-tony-window=2026
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DRY_RUN = !process.argv.includes('--write');
const ACK_ARG = process.argv.find((a) => a.startsWith('--ack-tony-window='));

const TONY_FREEZE_START_MONTH = 5; // June (0-indexed)
const TONY_FREEZE_END_MONTH = 5;   // through end of June
function inTonyWindow() {
  const now = new Date();
  return now.getMonth() === TONY_FREEZE_START_MONTH || now.getMonth() === TONY_FREEZE_END_MONTH;
}
function tonyWindowYear() { return new Date().getFullYear(); }

if (inTonyWindow()) {
  const expectedAck = `--ack-tony-window=${tonyWindowYear()}`;
  if (!ACK_ARG || ACK_ARG !== expectedAck) {
    console.error(`✗ TONY-WINDOW GATE: rebuilds are blocked during June (peak traffic week).`);
    console.error(`  Predictions page re-ranks visibly during rebuilds; defer until July.`);
    console.error(`  To override (NOT RECOMMENDED): pass ${expectedAck}`);
    process.exit(2);
  }
  console.warn(`⚠️  TONY-WINDOW override accepted via ${expectedAck} — proceeding.`);
}

const AWARDS_PATH = path.join(__dirname, '..', 'data', 'awards.json');
const PRECURSOR_FIELDS = ['dramadesk', 'outerCriticsCircle', 'dramaLeague', 'lortel'];

console.log('Loading awards.json...');
const awards = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));

// Snapshot for rollback / coverage diff
const before = JSON.parse(JSON.stringify(awards));

let clearedWins = 0;
let clearedShows = 0;
for (const sh of Object.values(awards.shows || {})) {
  let touched = false;
  for (const f of PRECURSOR_FIELDS) {
    if (!sh[f]) continue;
    const winCount = Array.isArray(sh[f].wins) ? sh[f].wins.length : 0;
    if (winCount > 0) {
      clearedWins += winCount;
      sh[f].wins = [];
      touched = true;
    }
    if (sh[f].winnerNames && Object.keys(sh[f].winnerNames).length > 0) {
      delete sh[f].winnerNames;
      touched = true;
    }
  }
  if (touched) clearedShows++;
}

console.log(`Cleared wins on ${clearedShows} shows (${clearedWins} win entries total).`);

if (DRY_RUN) {
  console.log('[dry-run] would write cleared awards.json then re-enrich.');
  process.exit(0);
}

// Persist cleared state so enrich starts from a clean slate.
fs.writeFileSync(AWARDS_PATH, JSON.stringify(awards, null, 2));
console.log('Wrote cleared awards.json.');

// Shell out to enrich. Inherits the dual-repo write inside enrich.
console.log('\nInvoking enrich-awards-with-precursors.js...');
try {
  execFileSync('node', [path.join(__dirname, 'enrich-awards-with-precursors.js')], { stdio: 'inherit' });
} catch (e) {
  console.error('\n✗ Enrich failed. Restoring backup.');
  fs.writeFileSync(AWARDS_PATH, JSON.stringify(before, null, 2));
  process.exit(1);
}

// Post-rebuild coverage check: compare per-ceremony win counts.
const after = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));
const COVERAGE_DROP_THRESHOLD = 0.10; // abort if any ceremony loses >10% of wins
const errors = [];
for (const f of PRECURSOR_FIELDS) {
  const bw = Object.values(before.shows || {}).reduce((s, sh) => s + (sh[f] && sh[f].wins ? sh[f].wins.length : 0), 0);
  const aw = Object.values(after.shows || {}).reduce((s, sh) => s + (sh[f] && sh[f].wins ? sh[f].wins.length : 0), 0);
  const drop = bw > 0 ? (bw - aw) / bw : 0;
  console.log(`  ${f.padEnd(20)} before: ${bw}  after: ${aw}  Δ: ${aw - bw}`);
  if (drop > COVERAGE_DROP_THRESHOLD) {
    errors.push(`${f}: dropped ${(drop * 100).toFixed(1)}% (${bw} → ${aw})`);
  }
}

if (errors.length > 0) {
  console.error('\n✗ COVERAGE GATE FAILED:');
  for (const e of errors) console.error('  ' + e);
  console.error('\nRestoring backup. Inspect data/precursors/*.json — likely format drift.');
  fs.writeFileSync(AWARDS_PATH, JSON.stringify(before, null, 2));
  process.exit(3);
}

console.log('\n✓ Rebuild complete. Run precursor-rebuild-delta.js to inspect changes.');
