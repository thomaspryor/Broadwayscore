#!/usr/bin/env node
/**
 * dump-commercial-entries.js — read-only: print commercial.json entries (with the
 * shows.json venue/dates) so a cloud session with a stale data copy can see live
 * values through cloud-run-script.js before writing a data-edit plan (BRO-6137).
 *
 * Usage: node scripts/dump-commercial-entries.js --slugs=a,b,c
 *        node scripts/dump-commercial-entries.js --closed-tbd
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const commercial = JSON.parse(fs.readFileSync(path.join(DATA, 'commercial.json'), 'utf8')).shows;
const bySlug = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'shows.json'), 'utf8')).shows.map(s => [s.slug, s]));

const arg = process.argv.slice(2).find(a => a.startsWith('--slugs='));
let slugs = arg ? arg.slice(8).split(',').filter(Boolean) : [];
if (process.argv.includes('--closed-tbd')) {
  slugs = Object.keys(commercial).filter(k => commercial[k].designation === 'TBD' && (bySlug.get(k) || {}).status === 'closed');
}

for (const slug of slugs) {
  const s = bySlug.get(slug) || {};
  const slim = Object.fromEntries(Object.entries(commercial[slug] || { missing: true }).filter(([k]) => !/^model|^research|^lastRes|^deepResearch/.test(k)));
  console.log(JSON.stringify({ slug, title: s.title, type: s.type, theater: s.venue, opened: s.openingDate, closed: s.closingDate, ...slim }));
}
