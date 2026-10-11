'use strict';

// backtest-recoupment-ground-truth.js --timing (BRO-5073): replays the model
// at each recouped show's announcement (and 26/52 weeks before it) with the
// recoupment hidden. Rules and truth bands: scripts/lib/recoupment-timing.js.
// Old side = --base (or the working tree), new side = working tree.

const path = require('path');
const { timingTruth, windowError, historyCoverage, modelAt, displayableAt, hideRecoupment } = require('./recoupment-timing');
const { category, summarize, worseGroups, formatMarkdown, fmtTruth } = require('./recoupment-ground-truth');
const guard = require('./model-display-guard');

// The replay needs weekly grosses for most of the run so far; the model
// fills the rest with averages.
const MIN_COVERAGE = 0.75;

function libsFrom(dir) {
  return {
    classifyTier: require(path.join(dir, 'model-return-v2.js')).classifyTier,
    calculateRecoupment: require(path.join(dir, 'recoupment-model.js')).calculateRecoupment,
  };
}

/**
 * @returns {{ rows: object[], skipped: Record<string, number> }}
 */
function buildTimingRows({ shows, commercial, lookup, by, oldLibs, newLibs, newOpts = {}, truth = 'reported', displayableOnly = false, displayed = false }) {
  const rows = [];
  const skipped = { noShow: 0, untestable: 0, inference: 0, sharedGrossesKey: 0, thinHistory: 0, noModel: 0, notDisplayable: 0, newOnly: 0 };
  const shown = (v) => (displayed ? Math.max(0, v) : v);
  for (const [key, rawComm] of Object.entries(commercial)) {
    if (rawComm.recouped !== true) continue;
    const show = by[key] || by[rawComm.slug] || by[key.replace(/-\d{4}$/, '')];
    if (!show) { skipped.noShow++; continue; }
    const t = timingTruth(rawComm, show);
    if (!t) { skipped.untestable++; continue; }
    if (truth === 'reported' && t.truthClass !== 'reported') { skipped.inference++; continue; }
    const comm = hideRecoupment(rawComm);
    const weekly = lookup.getWeeklyData(show.slug || show.id, show.id);
    for (const cp of t.checkpoints) {
      const cov = historyCoverage(weekly, show, cp.to);
      const weeks = guard.playedWeeks(show, new Date(cp.to));
      if (cov.before > 0) { skipped.sharedGrossesKey++; continue; }
      if (!(weeks > 0) || cov.own / weeks < MIN_COVERAGE) { skipped.thinHistory++; continue; }
      const run = (libs, d, opts) => modelAt(libs, show, comm, lookup, d, opts);
      const oldA = run(oldLibs, cp.from); const oldB = cp.from === cp.to ? oldA : run(oldLibs, cp.to);
      const newA = run(newLibs, cp.from, newOpts); const newB = cp.from === cp.to ? newA : run(newLibs, cp.to, newOpts);
      const okOld = oldA.result && oldB.result;
      const okNew = newA.result && newB.result;
      if (okOld && !okNew) { skipped.newOnly++; continue; }
      if (!okOld || !okNew) { skipped.noModel++; continue; }
      const disp = displayableAt({ comm, tier: newB.tier, result: newB.result, playedWeeks: weeks }, guard);
      if (displayableOnly && !disp) { skipped.notDisplayable++; continue; }
      const c = (r) => shown(r.result.recoupmentPctCentral);
      const range = { lo: cp.lo, hi: cp.hi };
      rows.push({
        slug: key, kind: `timing:${cp.label}`, truthClass: t.truthClass, ...category(show),
        truth: [cp.lo, cp.hi], from: cp.from, to: cp.to, precision: t.announcement.precision,
        oldPct: c(oldB), newPct: c(newB), oldFrom: c(oldA), newFrom: c(newA),
        oldErr: windowError(c(oldA), c(oldB), range), newErr: windowError(c(newA), c(newB), range),
        displayable: disp, playedWeeks: weeks,
        capitalization: newB.result.capitalization, weeklyCost: newB.result.weeklyFixedCosts,
        costSource: newB.result.weeklyFixedCostSource, taxCredit: newB.result.taxCreditAmount,
      });
    }
  }
  return { rows, skipped };
}

/** Mean signed miss at recoupment (central at the window end minus 100): + reads high, - low. */
function recoupBias(rows, side = 'new') {
  const at = rows.filter((r) => r.kind === 'timing:at-recoup');
  if (!at.length) return null;
  return Math.round(at.reduce((a, r) => a + (r[`${side}Pct`] - 100), 0) / at.length * 10) / 10;
}

function runTiming({ shows, commercial, lookup, by, baseLib, newLib, newOpts = {}, base, truth, displayableOnly, displayed, json, strict, aggregateOnly, markdown }) {
  const { rows, skipped } = buildTimingRows({
    shows, commercial, lookup, by, oldLibs: libsFrom(baseLib), newLibs: libsFrom(newLib), newOpts, truth, displayableOnly, displayed,
  });
  const MIN_GROUP = displayableOnly ? 3 : 1;
  const summary = summarize(rows);
  const worse = worseGroups(summary, { minN: MIN_GROUP });
  // A show the new side calls recouped 26 or 52 weeks before it did.
  const newEarly = rows.filter((r) => r.truth[1] < 100 && r.newPct >= 100 && !(r.oldPct >= 100));
  const displayableHard = rows.filter((r) => r.displayable && r.truthClass === 'reported').length;
  const optNames = Object.keys(newOpts);
  const label = `${base ? `${base} vs working tree` : 'working tree'}${optNames.length ? `, opts ${optNames.join(', ')}` : ''}, recoupment timing${displayableOnly ? ', displayable rows only' : ''}${displayed ? ', displayed value (floored at 0)' : ''}`;
  const lines = [
    `Truth set: ${truth === 'reported' ? `reported recoupment dates only, ${skipped.inference} inference records left out` : 'reported and inference'}`,
    `Recoupment-timing backtest, ${label}: ${rows.length} checkpoints (skipped ${Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`,
    `Displayable hard-truth checkpoints (would show a bar with the launch flag on): ${displayableHard}`,
    `Bias at recoupment (mean central - 100): old ${recoupBias(rows, 'old')}, new ${recoupBias(rows, 'new')}`,
    `New early recouped (>= 100 at 26/52 weeks before): ${newEarly.length}${newEarly.length && !aggregateOnly ? ` (${newEarly.map((r) => `${r.slug} ${r.kind}`).join(', ')})` : ''}`,
  ];
  if (json) {
    console.log(JSON.stringify({ mode: 'timing', base: base || null, truth, summary, worse, skipped, displayableHard, bias: { old: recoupBias(rows, 'old'), new: recoupBias(rows, 'new') }, ...(aggregateOnly ? {} : { rows }) }, null, 2));
  } else if (markdown) {
    console.log(formatMarkdown({ title: `Recoupment-timing backtest: ${label} (${rows.length} checkpoints)`, summary, rows, worse, aggregateOnly }));
    console.log(lines.join('\n\n'));
  } else {
    console.log(lines.join('\n'));
    console.log('group                     n   old MAE  new MAE  old median  new median  old inside  new inside');
    for (const [g, s] of Object.entries(summary)) {
      console.log(`${g.padEnd(25)} ${String(s.n).padStart(3)}  ${String(s.oldMae).padStart(7)}  ${String(s.newMae).padStart(7)}  ${String(s.oldMedian).padStart(10)}  ${String(s.newMedian).padStart(10)}  ${String(s.oldInside).padStart(10)}  ${String(s.newInside).padStart(10)}`);
    }
    if (!aggregateOnly) {
      console.log('Worst 10 (new side):');
      for (const r of [...rows].sort((a, b) => b.newErr - a.newErr).slice(0, 10)) {
        console.log(`  ${r.slug} [${r.kind} ${r.from}..${r.to}, truth ${fmtTruth(r.truth)}]: ${r.newFrom}..${r.newPct} (error ${Math.round(r.newErr * 10) / 10}; cap ${r.capitalization}, cost ${r.weeklyCost} ${r.costSource}, ${r.playedWeeks} wk${r.displayable ? ', displayable' : ''})`);
      }
    }
    console.log(worse.length ? `WORSE in: ${worse.join(', ')}` : `No group${MIN_GROUP > 1 ? ` of ${MIN_GROUP}+ rows` : ''} got worse.`);
  }
  if (strict && (worse.length || newEarly.length || skipped.newOnly)) process.exitCode = 1;
}

module.exports = { buildTimingRows, recoupBias, runTiming, libsFrom, MIN_COVERAGE };
