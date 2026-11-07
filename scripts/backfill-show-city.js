#!/usr/bin/env node
'use strict';
/**
 * One-off (BRO-6515): set `city` (metro slug) on every market:'regional' show
 * from data/venue-metros.json. Core data lives in a private repo, so this does
 * not write shows.json: it prints the mapped/unmapped report and, with
 * --plan=bro-N, hands the edits to new-fix-plan.js (CLOUD.md private-data flow).
 * Tours are skipped on purpose: a tour is many cities (its stops drive /tours/[city]).
 *
 *   node scripts/backfill-show-city.js            # report only
 *   node scripts/backfill-show-city.js --plan=bro-6515
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveMetro } = require('./lib/venue-metro');
const { hasHelpFlag } = require('./lib/cli-help.js');

function planCityEdits(shows) {
  const edits = [];
  const unmapped = [];
  const unchanged = [];
  for (const s of shows) {
    if (!s || s.market !== 'regional') continue;
    const city = resolveMetro(s.venue);
    if (!city) unmapped.push(s);
    else if (s.city === city) unchanged.push(s);
    else edits.push({ id: s.id, from: s.city ?? null, city });
  }
  return { edits, unmapped, unchanged };
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/backfill-show-city.js [--plan=bro-N]  (report; --plan writes a fix plan via new-fix-plan.js)');
    return;
  }
  const planArg = process.argv.find((a) => a.startsWith('--plan='));
  const raw = require(path.join(__dirname, '..', 'data', 'shows.json'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const { edits, unmapped, unchanged } = planCityEdits(shows);
  for (const e of edits) console.log(`SET   ${e.id} city=${e.city}${e.from ? ` (was ${e.from})` : ''}`);
  for (const s of unmapped) console.log(`UNMAPPED ${s.id} | ${s.venue}`);
  console.log(`regional: ${edits.length} to set, ${unchanged.length} already set, ${unmapped.length} unmapped`);
  if (!planArg || !edits.length) return;
  const id = planArg.split('=')[1];
  const args = [path.join(__dirname, 'new-fix-plan.js'), `--id=${id}`,
    `--summary=Set city metro slug on ${edits.length} regional shows from data/venue-metros.json (${id.toUpperCase()})`,
    '--risk=low', ...edits.map((e) => `--edit=${e.id}.city=${e.city}`)];
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}

if (require.main === module) main();
module.exports = { planCityEdits };
