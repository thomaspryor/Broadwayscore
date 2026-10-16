#!/usr/bin/env node
'use strict';

// Shadow report for the model display guard (BRO-4989 checker #5): which
// records the site shows the model "% returned" bar for today, and what the
// guard (scripts/lib/model-display-guard.js) would do to each. Read-only.
//
// Usage: node scripts/shadow-display-guard.js [--all-markets] [--json]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { modelDisplayGuard, displaysModel, playedWeeks, independentEstimate, isRunning } = require('./lib/model-display-guard');

const args = process.argv.slice(2);
if (require('./lib/cli-help').hasHelpFlag(args)) {
  console.log('Usage: node scripts/shadow-display-guard.js [--all-markets] [--json]');
  process.exit(0);
}
const DATA = path.join(__dirname, '..', 'data');
const dataFile = (f) => (fs.existsSync(path.join(DATA, f)) ? path.join(DATA, f) : path.join(os.homedir(), 'broadway-scorecard-data', f));
const load = (f) => JSON.parse(fs.readFileSync(dataFile(f), 'utf8'));

const shows = Object.values(load('shows.json').shows);
const commercial = load('commercial.json').shows;
const by = {};
for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id && !by[s.id]) by[s.id] = s; }

const rows = [];
for (const [key, comm] of Object.entries(commercial)) {
  const show = by[key];
  if (!show) continue;
  if (!args.includes('--all-markets') && show.market && show.market !== 'broadway') continue;
  if (!displaysModel(comm, show)) continue;
  const weeks = playedWeeks(show);
  const reported = independentEstimate(comm);
  const running = isRunning(show);
  // closed as the site passes it (applyModelDisplayGuard, BRO-5502).
  const g = modelDisplayGuard({ pct: comm.modelRecoupmentPct, playedWeeks: weeks, independent: reported, running, closed: !running, showType: show.type ?? null });
  rows.push({ slug: key, status: show.status, weeks, pct: comm.modelRecoupmentPct, reported, ...g });
}

if (args.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const hidden = rows.filter((r) => !r.show);
  const floored = rows.filter((r) => r.show && r.belowCosts);
  console.log(`Model bar shown today on ${rows.length} records. Guard: ${rows.length - hidden.length} still shown (${floored.length} as "0% returned, losing money so far"), ${hidden.length} hidden.`);
  const fmt = (p) => p.map((v) => Math.round(v)).join('/');
  for (const r of rows.sort((a, b) => String(a.reason).localeCompare(String(b.reason)) || a.slug.localeCompare(b.slug))) {
    const rep = r.reported ? ` reported ${r.reported.join('-')}` : '';
    const what = r.show ? (r.belowCosts ? `SHOWN as 0% (below costs), bar ${fmt(r.shown)}` : `shown ${fmt(r.shown)}`) : `HIDDEN (${r.reason})`;
    console.log(`  ${r.slug} [${r.status}, ${r.weeks} wks] model ${fmt(r.pct)}${rep}: ${what}`);
  }
}
