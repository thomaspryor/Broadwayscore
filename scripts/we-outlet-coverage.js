#!/usr/bin/env node
/**
 * BRO-6480: per-outlet coverage for West End historical seasons.
 * % of we-historical shows in each season that hold a counted (scored) review from the outlet slot.
 *
 *   node scripts/we-outlet-coverage.js [--seasons=2012..2016] [--slots=guardian,stage] [--json]
 *
 * Reads data/shows.json + data/reviews.json (same slot map as we-major-recovery.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib/we-major-recovery.js');

const ROOT = path.join(__dirname, '..');
const arg = n => process.argv.slice(2).find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const rd = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const DEFAULT_SLOTS = ['guardian', 'telegraph', 'standard', 'times', 'stage', 'whatsonstage'];

function coverage(rows, slots) {
  const bySeason = {};
  for (const r of rows) {
    const o = (bySeason[r.season] = bySeason[r.season] || { shows: 0, counted: 0, held: Object.fromEntries(slots.map(s => [s, 0])) });
    o.shows++; o.counted += r.counted;
    for (const s of slots) if (!r.missing.includes(s)) o.held[s]++;
  }
  return Object.fromEntries(Object.entries(bySeason).sort().map(([season, o]) => [season, {
    shows: o.shows, avgCounted: +(o.counted / o.shows).toFixed(1),
    pct: Object.fromEntries(slots.map(s => [s, Math.round(100 * o.held[s] / o.shows)])),
  }]));
}

if (require.main === module) {
  const m = String(arg('seasons') || '2012..2016').match(/^(\d{4})(?:\.\.(\d{4}))?$/);
  const [from, to] = m ? [+m[1], +(m[2] || m[1])] : [2012, 2016];
  const slots = arg('slots') ? arg('slots').split(',') : DEFAULT_SLOTS;
  const rows = lib.buildSlots(rd('data/shows.json').shows, rd('data/reviews.json').reviews, from, to);
  const cov = coverage(rows, slots);
  if (process.argv.includes('--json')) console.log(JSON.stringify(cov, null, 1));
  else {
    console.log(['season', 'shows', 'cnt/show', ...slots].join('\t'));
    for (const [k, v] of Object.entries(cov)) console.log([k, v.shows, v.avgCounted, ...slots.map(s => v.pct[s] + '%')].join('\t'));
  }
}
module.exports = { coverage };
