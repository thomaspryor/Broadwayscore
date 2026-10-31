#!/usr/bin/env node
/**
 * audit-wet-archive-market.js (BRO-6682)
 *
 * Lists WestEndTheatre archives (data/aggregator-archive/westendtheatre/*.json)
 * attached to a non-London show or to a post that predates the run (see
 * lib/wet-archive-guard.js). Read-only; exit 1 when any are found.
 *
 * Usage: node scripts/audit-wet-archive-market.js [--archive-dir=DIR] [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}
const { auditWetArchives, showsFromJson } = require('./lib/wet-archive-guard');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const dir = arg('archive-dir', path.join(ROOT, 'data', 'aggregator-archive', 'westendtheatre'));

const raw = require('../data/shows.json');
const shows = showsFromJson(raw);
if (!shows.length) {
  console.error('audit-wet-archive-market: no show rows read from data/shows.json; refusing to report every archive as unknown');
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  console.log(`audit-wet-archive-market: no archive dir at ${dir} (private review-texts not attached); nothing checked`);
  process.exit(0);
}
const archives = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
  try { archives.push({ showId: f.replace(/\.json$/, ''), archive: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); } catch (_) { /* unreadable: not this audit's job */ }
}
const findings = auditWetArchives(shows, archives);
if (argv.includes('--json')) console.log(JSON.stringify({ checked: archives.length, findings }, null, 2));
else {
  console.log(`audit-wet-archive-market: ${archives.length} archives checked, ${findings.length} bad`);
  for (const f of findings) console.log(`  ${f.showId}: ${f.code} (${f.detail}) ${f.postUrl || ''}`);
}
process.exit(findings.length ? 1 : 0);
