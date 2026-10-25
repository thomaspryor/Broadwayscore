#!/usr/bin/env node
'use strict';

/**
 * shadow-model-fix.js — before/after diff for one recoupment-model fix at a
 * time (BRO-4989 children). Runs the live model exactly as
 * merge-model-recoupment.js does, then again with the fix's option on, and
 * compares modelRecoupmentPct and the recouped call. Writes nothing but
 * --out. Live fields are untouched until the checking session approves a
 * switch.
 *
 *   node scripts/shadow-model-fix.js --fix=previews|played-weeks [--out=FILE] [--show=SLUG]
 *
 *   previews      BRO-5002: preview weeks already in the weekly grosses are
 *                 not estimated again (scripts/lib/preview-weeks.js)
 *   played-weeks  BRO-5003: a running show's weeks count to today, not to an
 *                 announced closing date (scripts/lib/run-window.js)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { calculateRecoupment, calculateLifetimeRecoupment } = require('./lib/recoupment-model');
const { classifyTier, TIERS, modelReturnV2 } = require('./lib/model-return-v2');
const { previewWeeksFromWeekly } = require('./lib/preview-weeks');
const { makeGrossesLookup } = require('./lib/grosses-lookup');
const { modelContradictsDesignation: contradiction, modelSizesLossLabel, lossDesignationFor, returnedEstimatePct } = require('./lib/commercial-designations');
const { RETURNED_SO_FAR_OPTS } = require('./lib/model-run-fields');

const futureClosing = (show) => !!show.closingDate && new Date(show.closingDate) > new Date();
const covered = (show, weekly, live) => previewWeeksFromWeekly(
  Object.keys(weekly || {}).sort(), show.openingDate, live.previewWeeks, show.previewsStartDate,
).covered;

const FIXES = {
  previews: {
    opts: { previewsFromWeekly: true },
    tiers: ['weekly-model'], // only the weekly schedule estimates previews on top of real rows
    // A weekly-model show can still fall back to the all-time schedule
    // (grossDataSource alltime-*), which ignores the option.
    affected: (show, weekly, live) => !String(live.grossDataSource).startsWith('alltime')
      && covered(show, weekly, live) > 0,
    why: (show, weekly, live) => `${covered(show, weekly, live)} of ${live.previewWeeks} preview weeks already in weekly grosses`,
    // With an announced future closing, live gap-fills unplayed weeks (BRO-5003),
    // so dropping estimated previews there swaps low preview weeks for
    // average-gross gap weeks instead of removing a double count. Those rows
    // are reported apart, with the effect measured on top of played-weeks.
    isolate: { opts: { playedWeeksOnly: true }, when: (show) => futureClosing(show) },
  },
  'played-weeks': {
    opts: { playedWeeksOnly: true },
    tiers: ['weekly-model', 'simplified-lifetime'],
    affected: (show) => futureClosing(show),
    why: (show) => `closing ${String(show.closingDate).slice(0, 10)} counted as played`,
  },
};

// A misspelt tier silently skips every show in it (a misnamed lifetime tier once did).
for (const [name, fix] of Object.entries(FIXES)) {
  for (const t of fix.tiers) if (!TIERS.includes(t)) throw new Error(`--fix=${name}: unknown tier "${t}" (classifyTier returns ${TIERS.join(', ')})`);
}

const DATA = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = fs.existsSync(path.join(DATA, 'commercial.json'))
  ? path.join(DATA, 'commercial.json')
  : path.join(os.homedir(), 'broadway-scorecard-data', 'commercial.json');
const args = process.argv.slice(2);
const USAGE = `Usage: node scripts/shadow-model-fix.js --fix=${Object.keys(FIXES).join('|')} [--out=FILE] [--show=SLUG]  (report only; see header)`;
if (require('./lib/cli-help').hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
const FIX = FIXES[args.find((a) => a.startsWith('--fix='))?.split('=')[1]];
if (!FIX) { console.error(USAGE); process.exit(2); }
const OFF = Object.fromEntries(Object.keys(FIX.opts).map((k) => [k, false]));
const OUT = args.find((a) => a.startsWith('--out='))?.split('=')[1];
const ONLY = args.find((a) => a.startsWith('--show='))?.split('=')[1];

// Thresholds the live /biz cards apply to modelRecoupmentPct (src/lib/commercial-metrics.ts
// AT_RISK_MAX_RECOUPED_PCT, APPROACHING_MIN_LOW_PCT, MIN_WEEKS_PER_WINDOW; a TS file, so copied).
const AT_RISK_MAX = 30;
const APPROACHING_MIN = 50;
const MIN_WEEKS = 3;

// The other half of isAtRisk: trailing 4-week average gross under break-even
// (getBreakEven: modelBreakeven floored at weeklyRunningCost, else the cost).
// It reads stored fields and grosses, so a model fix cannot change it; a pct
// flip only matters when this half already holds. Approximate: skips the
// model-quality floor, so it can only over-report.
function grossUnderBreakEven(comm, weeklyRows) {
  const recent = Object.keys(weeklyRows || {}).sort().slice(-4)
    .map((k) => (typeof weeklyRows[k] === 'object' ? weeklyRows[k]?.gross : weeklyRows[k]))
    .filter((g) => typeof g === 'number');
  if (recent.length < MIN_WEEKS) return false;
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const cost = comm.weeklyRunningCost ?? null;
  const be = comm.modelBreakeven ? (cost != null && comm.modelBreakeven < cost && comm.weeklyRunningCostBasis !== 'all-in' ? cost : comm.modelBreakeven) : cost;
  return be != null && be > 0 && avg < be;
}

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pcts = (r) => [r.recoupmentPctLow, r.recoupmentPctCentral, r.recoupmentPctHigh];

function main() {
  const shows = Object.values(load(path.join(DATA, 'shows.json')).shows);
  const commercial = load(COMMERCIAL_PATH).shows;
  const L = makeGrossesLookup(load(path.join(DATA, 'grosses.json')), load(path.join(DATA, 'grosses-history.json')));
  const by = {};
  for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }

  const rows = [];
  let modeled = 0;
  for (const [key, comm] of Object.entries(commercial)) {
    if (ONLY && key !== ONLY) continue;
    const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
    if (!show) continue;
    const slug = show.slug || show.id;
    const all = L.getGrossesAllTime(slug, show.id);
    const tier = classifyTier(show, comm, all);
    if (!FIX.tiers.includes(tier)) continue;
    const weekly = tier === 'weekly-model' ? L.getWeeklyData(slug, show.id) : null;
    const run = (opts) => (tier === 'weekly-model'
      ? calculateRecoupment(show, comm, all, weekly, opts)
      : calculateLifetimeRecoupment(show, comm, all, opts));
    // The fix's options forced off: some are already live for musicals
    // (MUSICAL_LIVE_OPTS, BRO-5598), so a bare run would already include them.
    const live = run(OFF);
    if (live.error) continue;
    modeled++;
    if (!FIX.affected(show, weekly, live)) continue;
    const fixed = run(FIX.opts);
    if (fixed.error) continue;
    const oldPct = pcts(live);
    const newPct = pcts(fixed);
    let isolated = null;
    if (FIX.isolate && FIX.isolate.when(show)) {
      const base = run({ ...OFF, ...FIX.isolate.opts });
      const both = run({ ...OFF, ...FIX.isolate.opts, ...FIX.opts });
      if (!base.error && !both.error) isolated = { basePct: pcts(base), fixedPct: pcts(both) };
    }
    const running = !show.closingDate || new Date(show.closingDate) > new Date();
    const effects = [];
    if (live.modelRecouped !== fixed.modelRecouped) effects.push(`model recouped ${live.modelRecouped} -> ${fixed.modelRecouped}`);
    if (running && comm.recouped !== true) {
      if ((oldPct[2] < AT_RISK_MAX) !== (newPct[2] < AT_RISK_MAX)) {
        effects.push(grossUnderBreakEven(comm, L.getWeeklyData(slug, show.id))
          ? `At Risk test (optimistic < ${AT_RISK_MAX}%, gross under break-even) ${oldPct[2]} -> ${newPct[2]}`
          : `at-risk pct only (gross at or over break-even, no listing change) ${oldPct[2]} -> ${newPct[2]}`);
      }
      if ((oldPct[0] >= APPROACHING_MIN) !== (newPct[0] >= APPROACHING_MIN)) effects.push(`Approaching test (pessimistic >= ${APPROACHING_MIN}%) ${oldPct[0]} -> ${newPct[0]}`);
    }
    if (contradiction(oldPct[1], comm.designation) !== contradiction(newPct[1], comm.designation)) {
      effects.push(`designation-contradiction flag ${contradiction(oldPct[1], comm.designation)} -> ${contradiction(newPct[1], comm.designation)}`);
    }
    // A loss label our model sizes follows its returned-so-far figure, which
    // the model writer re-reads every run (BRO-5643): a fix that carries it
    // across the 30% line moves a public label.
    if (modelSizesLossLabel(comm)) {
      // The fields the writer stores (model-run-fields.js), read in the same order.
      const label = (opts, main) => {
        const r = run({ ...OFF, ...opts, ...RETURNED_SO_FAR_OPTS });
        return lossDesignationFor(returnedEstimatePct({
          modelDataQuality: main.dataQuality,
          modelReturnedExCreditPct: r.error ? undefined : pcts(r),
          modelRecoupmentPctV2: modelReturnV2(main, show)?.recoupmentPctV2,
          modelRecoupmentPct: pcts(main),
        }));
      };
      const before = label({}, live);
      const after = label(FIX.opts, fixed);
      if (before !== after) effects.push(`loss label ${before} -> ${after}`);
    }
    rows.push({
      slug: key, tier, designation: comm.designation || null, recouped: comm.recouped ?? null,
      why: FIX.why(show, weekly, live),
      weeksBefore: live.totalRunWeeks, weeksAfter: fixed.totalRunWeeks,
      oldPct, newPct, effects, isolated,
    });
  }

  // A sign change (e.g. -50% -> +50%) is always a big move; otherwise log ratio of magnitudes.
  const signFlip = (r) => Math.sign(r.newPct[1]) * Math.sign(r.oldPct[1]) < 0;
  const ratio = (r) => (signFlip(r) ? 1e9 : Math.abs(Math.log((Math.abs(r.newPct[1]) + 1) / (Math.abs(r.oldPct[1]) + 1))));
  const has = (r, p) => r.effects.some((e) => e.startsWith(p));
  const changed = rows.filter((r) => r.newPct.some((v, i) => v !== r.oldPct[i]));
  const summary = {
    modeled,
    affected: rows.length,
    changed: changed.length,
    centralUp: rows.filter((r) => r.newPct[1] > r.oldPct[1]).length,
    centralDown: rows.filter((r) => r.newPct[1] < r.oldPct[1]).length,
    movesOver25pct: rows.filter((r) => Math.abs(r.newPct[1] - r.oldPct[1]) >= 10 && ratio(r) > Math.log(1.25)).length,
    recoupedFlips: rows.filter((r) => has(r, 'model recouped')).map((r) => `${r.slug}: ${r.effects.find((e) => e.startsWith('model recouped'))}`),
    atRiskFlips: rows.filter((r) => has(r, 'At Risk')).map((r) => r.slug),
    approachingFlips: rows.filter((r) => has(r, 'Approaching')).map((r) => r.slug),
    contradictionFlagFlips: rows.filter((r) => has(r, 'designation-contradiction')).map((r) => r.slug),
    designationChanges: rows.filter((r) => has(r, 'loss label')).length,
    lossLabelFlips: rows.filter((r) => has(r, 'loss label')).map((r) => `${r.slug}: ${r.effects.find((e) => e.startsWith('loss label'))}`),
  };
  if (FIX.isolate) {
    const iso = rows.filter((r) => r.isolated);
    summary.isolatedRows = iso.length;
    summary.isolatedNote = 'rows with an announced future closing: oldPct/newPct mix in the unplayed-weeks gap fill; isolated.* is this fix on top of played-weeks';
    summary.isolatedCentralUp = iso.filter((r) => r.isolated.fixedPct[1] > r.isolated.basePct[1]).length;
    summary.isolatedCentralDown = iso.filter((r) => r.isolated.fixedPct[1] < r.isolated.basePct[1]).length;
    summary.notIsolatedCentralUp = rows.filter((r) => !r.isolated && r.newPct[1] > r.oldPct[1]).length;
    summary.notIsolatedCentralDown = rows.filter((r) => !r.isolated && r.newPct[1] < r.oldPct[1]).length;
    // Played runs whose weekly history has holes: the removed estimates come
    // back as average-gross gap weeks for weeks that were played but have no row.
    summary.missingWeekRows = rows.filter((r) => !r.isolated && r.weeksBefore === r.weeksAfter).map((r) => r.slug);
  }
  const top = [...rows].sort((a, b) => ratio(b) - ratio(a)).slice(0, 10)
    .map((r) => `${r.slug}: ${r.oldPct[1]}% -> ${r.newPct[1]}% (${r.why}; ${r.weeksBefore} -> ${r.weeksAfter} weeks${r.isolated ? `; on played weeks ${r.isolated.basePct[1]}% -> ${r.isolated.fixedPct[1]}%` : ''}${r.effects.length ? `; ${r.effects.join('; ')}` : ''})`);

  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, top, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('Top moves:');
  for (const t of top) console.log(`  ${t}`);
}

main();
