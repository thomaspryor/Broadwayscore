#!/usr/bin/env node
/**
 * BRO-5182: drop commercial-pending-review.json entries that commercial.json
 * already covers with a cited record (rules: scripts/lib/pending-commercial-reconcile.js).
 * Never touches commercial.json and never researches anything.
 *
 *   node scripts/reconcile-pending-commercial.js            # report only
 *   node scripts/reconcile-pending-commercial.js --apply    # write the pending file
 *   --data-dir=PATH  read/write PATH instead of ./data (tests)
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { reconcilePending } = require('./lib/pending-commercial-reconcile');

const dirArg = process.argv.find((a) => a.startsWith('--data-dir='));
if (dirArg && !dirArg.slice('--data-dir='.length)) { console.error('--data-dir needs a path'); process.exit(2); }
const DATA = dirArg ? path.resolve(dirArg.slice('--data-dir='.length)) : path.join(__dirname, '..', 'data');
const PENDING = path.join(DATA, 'commercial-pending-review.json');
const apply = process.argv.includes('--apply');

const pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
const commercial = JSON.parse(fs.readFileSync(path.join(DATA, 'commercial.json'), 'utf8'));
const shows = JSON.parse(fs.readFileSync(path.join(DATA, 'shows.json'), 'utf8'));
const { drop, keep } = reconcilePending(pending.shows || {}, commercial.shows || {}, shows);

console.log(`pending ${Object.keys(pending.shows || {}).length}: covered ${drop.length}, still pending ${keep.length}`);
for (const k of keep) console.log(`  keep ${k.key} (${k.status || '?'}): ${k.reason}`);
for (const k of drop) console.log(`  drop ${k}`);
if (apply && drop.length) {
  for (const k of drop) delete pending.shows[k];
  pending.lastUpdated = new Date().toISOString();
  const tmp = `${PENDING}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pending, null, 2) + '\n');
  fs.renameSync(tmp, PENDING);
  console.log(`wrote ${PENDING} (${Object.keys(pending.shows).length} entries)`);
}
