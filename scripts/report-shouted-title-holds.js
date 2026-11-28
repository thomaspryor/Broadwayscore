#!/usr/bin/env node
/**
 * report-shouted-title-holds.js (BRO-3957): lists candidates held because their title
 * looks shouted, from discover-new-shows (data/audit/shouted-title-holds.json) and the
 * West End promoter (kind skip-shouted-title in data/audit/we-rejected-candidates.json).
 *
 *   node scripts/report-shouted-title-holds.js              list open holds
 *   node scripts/report-shouted-title-holds.js --resolve=<hash>   drop a hold once the real title is confirmed
 */
'use strict';
// venue-write-guard-ok: report-only listing of held candidates; no venue is written to shows.json.

const fs = require('fs');
const path = require('path');
const holds = require('./lib/shouted-title-holds');

const WE_FILE = path.join(__dirname, '..', 'data', 'audit', 'we-rejected-candidates.json');

function weShoutedHolds(file = WE_FILE) {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries((parsed && parsed.rejected) || {})
    .filter(([, e]) => e && e.kind === 'skip-shouted-title')
    .map(([hash, e]) => ({ hash, origin: 'promote-we-aggregator', title: e.title, venue: e.venue || null, source: e.source || null, discoveredAt: e.firstSeenAt || e.recordedAt || null }));
}

function main(argv = process.argv.slice(2)) {
  const resolve = (argv.find((a) => a.startsWith('--resolve=')) || '').slice('--resolve='.length);
  const store = holds.load();
  if (resolve) {
    const r = holds.resolveHold(store, resolve);
    if (!r.removed) { console.error(`no hold with hash ${resolve} in shouted-title-holds.json (WE entries expire on their own after the TTL)`); return 1; }
    holds.save(r.store);
    console.log(`resolved ${resolve}`);
    return 0;
  }
  const all = [...holds.listHolds(store), ...weShoutedHolds()];
  console.log(`${all.length} open shouted-title hold(s)`);
  for (const h of all) console.log(`- ${h.hash} [${h.origin}] "${h.title}" @ ${h.venue || 'no venue'} (since ${h.discoveredAt || '?'})`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, weShoutedHolds };
