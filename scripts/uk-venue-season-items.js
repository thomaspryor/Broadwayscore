#!/usr/bin/env node
'use strict';
/**
 * BRO-6692: venue-season reader for the UK hub houses. For each house it asks WhatsOnStage, The
 * Reviews Hub and British Theatre Guide for every review of that house since --since, so the
 * list is the productions that were professionally reviewed (not everything a venue announced).
 * Output is census-shaped items for `scripts/uk-regional-census-productions.js --items=<file>`,
 * which groups them into productions and applies the founding guards (twin, tour stop, and/&
 * duplicate check in uk-regional-add-plan.js) before anything is written.
 *
 *   node scripts/uk-venue-season-items.js --out=<items.json> [--since=2024-01-01] [--venues="Birmingham Rep,Liverpool Everyman"]
 */
const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help');
const { venueItems } = require('./lib/uk-live-index');
const { TABLE, resolveMetroInfo } = require('./lib/venue-metro');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BroadwayScorecardBot/1.0)' }, signal: AbortSignal.timeout(25000) });
      if (res.ok) return await res.text();
      if (res.status === 400 || res.status === 404) return '[]';
    } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  failures++;
  return '[]';
}

/** The house as outlets write it: the venue-metros name minus a trailing ", town". */
function houseTerm(venue) { return venue.split(',')[0].trim(); }

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log('Usage: node scripts/uk-venue-season-items.js --out=<items.json> [--since=YYYY-MM-DD] [--venues="A,B"]'); return 0; }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
  if (!arg('out')) { console.error('--out=<file> is required'); return 2; }
  const since = arg('since') || '2024-01-01';
  const hubHouses = TABLE.venues.filter((v) => TABLE.metros[v.metro] && TABLE.metros[v.metro].country === 'UK' && (resolveMetroInfo(v.venue) || {}).hub).map((v) => houseTerm(v.venue));
  const terms = arg('venues') ? arg('venues').split(',').map((x) => x.trim()) : [...new Set(hubHouses)];
  const all = new Map();
  for (const t of terms) {
    const items = await venueItems(t, since, get);
    for (const it of items) all.set(it.url, it);
    console.log(`${t}: ${items.length} reviews`);
    await sleep(500);
  }
  fs.writeFileSync(arg('out'), JSON.stringify([...all.values()], null, 1) + '\n');
  console.log(`${all.size} items -> ${arg('out')}`);
  if (failures) console.error(`WARNING: ${failures} index fetches failed after retries; the item list may be incomplete`);
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, houseTerm };
