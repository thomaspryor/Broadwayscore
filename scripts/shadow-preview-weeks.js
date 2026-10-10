#!/usr/bin/env node
'use strict';

/**
 * shadow-preview-weeks.js — before/after diff for the preview double-count
 * fix alone (BRO-5002, BRO-4989; scripts/lib/preview-weeks.js). Runs the live
 * weekly model exactly as merge-model-recoupment.js does, then again with
 * opts.previewsFromWeekly, and compares modelRecoupmentPct and the recouped
 * call. Writes nothing but --out. Live fields are untouched until the
 * checking session approves a switch.
 *
 *   node scripts/shadow-preview-weeks.js [--out=FILE] [--show=SLUG]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { calculateRecoupment } = require('./lib/recoupment-model');
const { classifyTier } = require('./lib/model-return-v2');
const { previewWeeksFromWeekly } = require('./lib/preview-weeks');
const { makeGrossesLookup } = require('./lib/grosses-lookup');
const { modelContradictsDesignation: contradiction } = require('./lib/commercial-designations');

const DATA = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = fs.existsSync(path.join(DATA, 'commercial.json'))
  ? path.join(DATA, 'commercial.json')
  : path.join(os.homedir(), 'broadway-scorecard-data', 'commercial.json');
const args = process.argv.slice(2);
if (require('./lib/cli-help').hasHelpFlag(args)) {
  console.log('Usage: node scripts/shadow-preview-weeks.js [--out=FILE] [--show=SLUG]  (report only; see header)');
  process.exit(0);
}
const OUT = args.find((a) => a.startsWith('--out='))?.split('=')[1];
const ONLY = args.find((a) => a.startsWith('--show='))?.split('=')[1];

// Thresholds the live /biz cards apply to modelRecoupmentPct (src/lib/commercial-metrics.ts).
const AT_RISK_MAX = 30;
const APPROACHING_MIN = 50;

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pcts = (r) => [r.recoupmentPctLow, r.recoupmentPctCentral, r.recoupmentPctHigh];

function main() {
  const shows = Object.values(load(path.join(DATA, 'shows.json')).shows);
  const commercial = load(COMMERCIAL_PATH).shows;
  const L = makeGrossesLookup(load(path.join(DATA, 'grosses.json')), load(path.join(DATA, 'grosses-history.json')));
  const by = {};
  for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }

  const rows = [];
  let weeklyModeled = 0;
  for (const [key, comm] of Object.entries(commercial)) {
    if (ONLY && key !== ONLY) continue;
    const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
    if (!show) continue;
    const slug = show.slug || show.id;
    const all = L.getGrossesAllTime(slug, show.id);
    if (classifyTier(show, comm, all) !== 'weekly-model') continue; // only Tier 1 changes
    const weekly = L.getWeeklyData(slug, show.id);
    const live = calculateRecoupment(show, comm, all, weekly);
    if (live.error) continue;
    weeklyModeled++;
    const fixed = calculateRecoupment(show, comm, all, weekly, { previewsFromWeekly: true });
    const { covered } = previewWeeksFromWeekly(Object.keys(weekly || {}).sort(), show.openingDate, live.previewWeeks);
    if (!covered) continue;
    const oldPct = pcts(live);
    const newPct = pcts(fixed);
    const running = !show.closingDate || new Date(show.closingDate) > new Date();
    const effects = [];
    if (live.modelRecouped !== fixed.modelRecouped) effects.push(`model recouped ${live.modelRecouped} -> ${fixed.modelRecouped}`);
    if (running && comm.recouped !== true) {
      if ((oldPct[2] < AT_RISK_MAX) !== (newPct[2] < AT_RISK_MAX)) effects.push(`At Risk test (optimistic < ${AT_RISK_MAX}%) ${oldPct[2]} -> ${newPct[2]}`);
      if ((oldPct[0] >= APPROACHING_MIN) !== (newPct[0] >= APPROACHING_MIN)) effects.push(`Approaching test (pessimistic >= ${APPROACHING_MIN}%) ${oldPct[0]} -> ${newPct[0]}`);
    }
    if (contradiction(oldPct[1], comm.designation) !== contradiction(newPct[1], comm.designation)) {
      effects.push(`designation-contradiction flag ${contradiction(oldPct[1], comm.designation)} -> ${contradiction(newPct[1], comm.designation)}`);
    }
    rows.push({
      slug: key, designation: comm.designation || null, recouped: comm.recouped ?? null,
      previewWeeks: live.previewWeeks, coveredByWeekly: covered,
      weeksBefore: live.totalRunWeeks, weeksAfter: fixed.totalRunWeeks,
      recoupWeekBefore: live.weeksToRecoupEstimate, recoupWeekAfter: fixed.weeksToRecoupEstimate,
      oldPct, newPct, effects,
    });
  }

  const ratio = (r) => Math.abs(Math.log((Math.abs(r.newPct[1]) + 1) / (Math.abs(r.oldPct[1]) + 1)));
  const has = (r, p) => r.effects.some((e) => e.startsWith(p));
  const summary = {
    weeklyModeled,
    affected: rows.length,
    unchanged: weeklyModeled - rows.length,
    centralUp: rows.filter((r) => r.newPct[1] > r.oldPct[1]).length,
    centralDown: rows.filter((r) => r.newPct[1] < r.oldPct[1]).length,
    movesOver25pct: rows.filter((r) => Math.abs(r.newPct[1] - r.oldPct[1]) >= 10 && ratio(r) > Math.log(1.25)).length,
    recoupedFlips: rows.filter((r) => has(r, 'model recouped')).map((r) => `${r.slug}: ${r.effects.find((e) => e.startsWith('model recouped'))}`),
    atRiskFlips: rows.filter((r) => has(r, 'At Risk')).map((r) => r.slug),
    approachingFlips: rows.filter((r) => has(r, 'Approaching')).map((r) => r.slug),
    contradictionFlagFlips: rows.filter((r) => has(r, 'designation-contradiction')).map((r) => r.slug),
    designationChanges: 0, // this change writes no designation
  };
  const top = [...rows].sort((a, b) => ratio(b) - ratio(a)).slice(0, 10)
    .map((r) => `${r.slug}: ${r.oldPct[1]}% -> ${r.newPct[1]}% (${r.coveredByWeekly} of ${r.previewWeeks} preview weeks already in weekly grosses; schedule ${r.weeksBefore} -> ${r.weeksAfter} weeks)`);

  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, top, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('Top moves:');
  for (const t of top) console.log(`  ${t}`);
}

main();
