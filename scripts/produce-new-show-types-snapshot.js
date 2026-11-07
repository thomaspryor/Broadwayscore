#!/usr/bin/env node
/**
 * produce-new-show-types-snapshot.js (BRO-6542)
 *
 * Writes data/audit/new-show-types-snapshot.json, which the morning digest
 * (scripts/send-morning-digest.js) renders as "New tour, pre-Broadway and UK
 * regional shows", with a suggested Reddit post for each new pre-Broadway show.
 * Also advances data/audit/new-show-types-seen.json, the ledger that decides
 * what counts as new. Logic lives in scripts/lib/new-show-types.js.
 *
 * Needs the private core data (data/shows.json), so it runs in
 * daily-digest.yml after the sparse core-data checkout.
 *
 *   node scripts/produce-new-show-types-snapshot.js            write both files
 *   node scripts/produce-new-show-types-snapshot.js --dry-run  print, write nothing
 */
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib/new-show-types');
require('./lib/cli-help').exitOnHelp(module);

const REPO = path.join(__dirname, '..');
const SHOWS_FILE = path.join(REPO, 'data', 'shows.json');
const SLIM_DIR = path.join(REPO, 'public', 'data', 'shows');
const AUDIT_DIR = path.join(REPO, 'data', 'audit');
const SNAPSHOT_FILE = path.join(AUDIT_DIR, 'new-show-types-snapshot.json');
const LEDGER_FILE = path.join(AUDIT_DIR, 'new-show-types-seen.json');
// shows.json holds thousands of rows; a read that returns far fewer means a
// bad checkout, and a fresh-looking empty snapshot would hide that.
const MIN_SHOWS = 500;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const raw = readJson(SHOWS_FILE);
  const shows = Array.isArray(raw) ? raw : (raw && raw.shows) || [];
  if (shows.length < MIN_SHOWS) {
    console.error(`[new-show-types] only ${shows.length} shows in data/shows.json (expected ${MIN_SHOWS}+); core data missing? Nothing written.`);
    return 1;
  }
  const now = new Date();
  const ledgerIn = readJson(LEDGER_FILE);
  if (!ledgerIn && fs.existsSync(LEDGER_FILE)) {
    console.error('[new-show-types] ledger exists but is not valid JSON; refusing to reseed. Nothing written.');
    return 1;
  }
  const { ledger, fresh } = lib.diffAgainstLedger(shows, ledgerIn, now);
  const slims = new Map();
  for (const show of lib.recentlySeen(shows, ledger, now)) {
    const slim = readJson(path.join(SLIM_DIR, `${show.id}.json`));
    if (slim) slims.set(show.id, slim);
  }
  const snapshot = lib.buildSnapshot({ shows, ledger, slims, now });
  if (!ledgerIn) console.log(`[new-show-types] first run: ${Object.values(ledger.seen).filter(v => v === 'seeded').length} existing shows recorded silently`);
  console.log(`[new-show-types] ${fresh.length} newly seen, ${snapshot.items.length + snapshot.moreCount} in the 48h window: ${snapshot.bannerText}`);
  for (const it of snapshot.items) console.log(`  ${it.kind.padEnd(12)} ${it.title} | ${it.detail}${it.reddit ? ' | reddit draft' : ''}`);
  if (dryRun) return 0;
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
