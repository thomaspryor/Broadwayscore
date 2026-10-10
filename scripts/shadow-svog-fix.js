#!/usr/bin/env node
'use strict';

/**
 * shadow-svog-fix.js — before/after diff for the SVOG-denominator fix alone
 * (BRO-4989 change 1; scripts/lib/model-return-v2.js). Runs the live model
 * exactly as merge-model-recoupment.js does, then compares its
 * modelRecoupmentPct with modelRecoupmentPctV2 and the investor multiple.
 * Writes nothing but --out.
 *
 *   node scripts/shadow-svog-fix.js [--out=FILE] [--show=SLUG]
 *
 * Exit 1 when a recouped call changes outside the one band where live floors
 * its denominator (closed, svog > cap - weeklyNut); see model-return-v2.js.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { calculateRecoupment, calculateLifetimeRecoupment } = require('./lib/recoupment-model');
const { modelReturnV2, classifyTier, isClosed } = require('./lib/model-return-v2');
const { makeGrossesLookup } = require('./lib/grosses-lookup');

const DATA = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = fs.existsSync(path.join(DATA, 'commercial.json'))
  ? path.join(DATA, 'commercial.json')
  : path.join(os.homedir(), 'broadway-scorecard-data', 'commercial.json');
const args = process.argv.slice(2);
if (require('./lib/cli-help').hasHelpFlag(args)) {
  console.log('Usage: node scripts/shadow-svog-fix.js [--out=FILE] [--show=SLUG]  (report only; see header)');
  process.exit(0);
}
const OUT = args.find((a) => a.startsWith('--out='))?.split('=')[1];
const ONLY = args.find((a) => a.startsWith('--show='))?.split('=')[1];

// Thresholds the live /biz cards apply to modelRecoupmentPct (src/lib/commercial-metrics.ts).
const AT_RISK_MAX = 30; // optimistic case
const APPROACHING_MIN = 50; // pessimistic case
// Same contradiction rule as merge-model-recoupment.js.
const { modelContradictsDesignation: contradiction } = require('./lib/commercial-designations');

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function main() {
  const shows = Object.values(load(path.join(DATA, 'shows.json')).shows);
  const commercial = load(COMMERCIAL_PATH).shows;
  const L = makeGrossesLookup(load(path.join(DATA, 'grosses.json')), load(path.join(DATA, 'grosses-history.json')));
  const by = {};
  for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }

  const rows = [];
  for (const [key, comm] of Object.entries(commercial)) {
    if (ONLY && key !== ONLY) continue;
    const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
    if (!show) continue;
    const slug = show.slug || show.id;
    const all = L.getGrossesAllTime(slug, show.id);
    const tier = classifyTier(show, comm, all);
    if (tier === 'ai-estimated') continue;
    const live = tier === 'weekly-model'
      ? calculateRecoupment(show, comm, all, L.getWeeklyData(slug, show.id))
      : calculateLifetimeRecoupment(show, comm, all);
    if (live.error) continue;
    const v2 = modelReturnV2(live, show);
    if (!v2) continue;
    const oldPct = [live.recoupmentPctLow, live.recoupmentPctCentral, live.recoupmentPctHigh];
    const running = !isClosed(show);
    const effects = [];
    if (live.modelRecouped !== v2.recouped) effects.push(`model recouped ${live.modelRecouped} -> ${v2.recouped}`);
    if (running && comm.recouped !== true) {
      if ((oldPct[2] < AT_RISK_MAX) !== (v2.recoupmentPctV2[2] < AT_RISK_MAX)) effects.push(`At Risk test (optimistic < ${AT_RISK_MAX}%) ${oldPct[2]} -> ${v2.recoupmentPctV2[2]}`);
      if ((oldPct[0] >= APPROACHING_MIN) !== (v2.recoupmentPctV2[0] >= APPROACHING_MIN)) effects.push(`Approaching test (pessimistic >= ${APPROACHING_MIN}%) ${oldPct[0]} -> ${v2.recoupmentPctV2[0]}`);
    }
    if (contradiction(oldPct[1], comm.designation) !== contradiction(v2.recoupmentPctV2[1], comm.designation)) {
      effects.push(`designation-contradiction flag ${contradiction(oldPct[1], comm.designation)} -> ${contradiction(v2.recoupmentPctV2[1], comm.designation)}`);
    }
    rows.push({
      slug: key, tier, designation: comm.designation || null, recouped: comm.recouped ?? null,
      cap: live.capitalization, svog: live.svogGrant, reserve: running ? live.reserveFund : 0,
      oldPct, newPct: v2.recoupmentPctV2, investorMultiple: v2.investorMultiple,
      svogOverCap: live.svogGrant > live.capitalization,
      nutFloorBand: !running && live.svogGrant > live.capitalization - (live.weeklyFixedCosts || 0), effects,
    });
  }

  const ratio = (r) => Math.abs(Math.log((Math.abs(r.newPct[1]) + 1) / (Math.abs(r.oldPct[1]) + 1)));
  const withSvog = rows.filter((r) => r.svog > 0);
  const moved = rows.filter((r) => Math.abs(r.newPct[1] - r.oldPct[1]) >= 10 && ratio(r) > Math.log(1.25));
  const badRecoup = rows.filter((r) => r.effects.some((e) => e.startsWith('model recouped')) && !r.svogOverCap && !r.nutFloorBand);
  const summary = {
    modeled: rows.length,
    withSvog: withSvog.length,
    unchanged: rows.filter((r) => r.svog === 0).length,
    movesOver25pct: moved.length,
    recoupedFlips: rows.filter((r) => r.effects.some((e) => e.startsWith('model recouped'))).map((r) => `${r.slug}: ${r.effects[0]}`),
    unexpectedRecoupedFlips: badRecoup.map((r) => r.slug),
    atRiskFlips: rows.filter((r) => r.effects.some((e) => e.startsWith('At Risk'))).map((r) => r.slug),
    approachingFlips: rows.filter((r) => r.effects.some((e) => e.startsWith('Approaching'))).map((r) => r.slug),
    contradictionFlagFlips: rows.filter((r) => r.effects.some((e) => e.startsWith('designation-contradiction'))).map((r) => r.slug),
    designationChanges: 0, // this change writes no designation
  };
  const top = [...withSvog].sort((a, b) => ratio(b) - ratio(a)).slice(0, 10)
    .map((r) => `${r.slug}: ${r.oldPct[1]}% -> ${r.newPct[1]}% (investor ${r.investorMultiple[1]}x; cap $${(r.cap / 1e6).toFixed(1)}M, SVOG $${(r.svog / 1e6).toFixed(1)}M${r.reserve ? `, reserve $${(r.reserve / 1e6).toFixed(1)}M` : ''})`);

  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, top, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('Top moves:');
  for (const t of top) console.log(`  ${t}`);
  if (badRecoup.length) {
    console.log(`::error::recouped call moved outside the nut-floor band: ${badRecoup.map((r) => r.slug).join(', ')}`);
    process.exit(1);
  }
}

main();
