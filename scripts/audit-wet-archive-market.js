#!/usr/bin/env node
/**
 * audit-wet-archive-market.js (BRO-6682)
 *
 * Lists WestEndTheatre archives (data/aggregator-archive/westendtheatre/*.json)
 * attached to a non-London show or to a post that predates the run (see
 * lib/wet-archive-guard.js). Read-only; exit 1 when any are found.
 *
 * --delete --expect=N (BRO-6690) removes the non-london-show archives on Broadway and
 * off-Broadway rows only (a WET roundup filed under such a row is another production's
 * and must not seed reviews again). Aborts, deleting nothing, if the count is
 * not N. Other codes and regional/tour rows are reported, never deleted. Delete only, no
 * tombstone: the scraper refuses to re-archive onto a non-London row
 * (lib/wet-archive-guard.js). Rollback is the private archive repo's history.
 *
 * Usage: node scripts/audit-wet-archive-market.js [--archive-dir=DIR] [--json] [--delete --expect=N]
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
if (argv.includes('--delete')) {
  // Default: Broadway/off-Broadway rows only (a UK regional or tour house is a place WET may really review).
  // --codes=a,b (BRO-6694) also deletes those finding codes, e.g. post-predates-run,unknown-show: an
  // archive for another run or for a show row that no longer exists is a stale cache, recoverable
  // from the private archive repo's history.
  const catOf = new Map(shows.map((x) => [x.id, x.category || 'broadway']));
  const codes = new Set(arg('codes', 'non-london-show').split(',').filter(Boolean));
  const bad = findings.filter((f) => codes.has(f.code) &&
    (f.code !== 'non-london-show' || ['broadway', 'off-broadway'].includes(catOf.get(f.showId))));
  const expect = Number(arg('expect', NaN));
  if (!Number.isInteger(expect) || bad.length !== expect) {
    console.error(`audit-wet-archive-market: --delete needs --expect=N matching the ${bad.length} archives with code ${[...codes].join('/')}; deleted nothing`);
    process.exit(2);
  }
  for (const f of bad) fs.unlinkSync(path.join(dir, `${f.showId}.json`));
  console.log(`audit-wet-archive-market: deleted ${bad.length} archives (${[...codes].join(', ')})`);
  process.exit(0);
}
process.exit(findings.length ? 1 : 0);
