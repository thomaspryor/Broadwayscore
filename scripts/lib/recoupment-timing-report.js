'use strict';

// backtest-recoupment-ground-truth.js --timing (BRO-5073): replays the model
// at each recouped show's announcement (and 26/52 weeks before it) with the
// recoupment hidden. Rules and truth bands: scripts/lib/recoupment-timing.js.
// Old side = --base (or the working tree), new side = working tree.

const path = require('path');
const { timingTruth, windowError, historyCoverage, modelAt, displayableAt, hideRecoupment } = require('./recoupment-timing');
const { category, summarize, worseGroups, newFalseRecouped, formatMarkdown, fmtTruth, eitherBasis, basisLine } = require('./recoupment-ground-truth');
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
function buildTimingRows({ shows, commercial, lookup, by, oldLibs, newLibs, newOpts = {}, truth = 'reported', displayableOnly = false, displayed = false, lagWeeks = 0 }) {
  const rows = [];
  const skipped = { noShow: 0, untestable: 0, inference: 0, sharedGrossesKey: 0, thinHistory: 0, noModel: 0, notDisplayable: 0, newOnly: 0 };
  const shown = (v) => (displayed ? Math.max(0, v) : v);
  for (const [key, rawComm] of Object.entries(commercial)) {
    if (rawComm.recouped !== true) continue;
    const show = by[key] || by[rawComm.slug] || by[key.replace(/-\d{4}$/, '')];
    if (!show) { skipped.noShow++; continue; }
    const t = timingTruth(rawComm, show, { lagWeeks });
    if (!t) { skipped.untestable++; continue; }
    if (truth === 'reported' && t.truthClass !== 'reported') { skipped.inference++; continue; }
    const comm = hideRecoupment(rawComm);
    // --opt=creditBasis: the new side scores the model on the truth's own
    // tax-credit basis (pre-credit: no credit in the model at all). An
    // unstated recoupment is scored on whichever basis fits at the
    // announcement; the earlier "< 100" checkpoints use the pre-credit
    // figure a running show would display.
    const basisOpts = (pre) => (newOpts.creditBasis ? { ...newOpts, taxCreditPre: pre } : newOpts);
    const weekly = lookup.getWeeklyData(show.slug || show.id, show.id);
    for (const cp of t.checkpoints) {
      const cov = historyCoverage(weekly, show, cp.to);
      const weeks = guard.playedWeeks(show, new Date(cp.to));
      if (cov.before > 0) { skipped.sharedGrossesKey++; continue; }
      if (!(weeks > 0) || cov.own / weeks < MIN_COVERAGE) { skipped.thinHistory++; continue; }
      const run = (libs, d, opts) => modelAt(libs, show, comm, lookup, d, opts);
      const oldA = run(oldLibs, cp.from); const oldB = cp.from === cp.to ? oldA : run(oldLibs, cp.to);
      const range = { lo: cp.lo, hi: cp.hi };
      const c = (r) => shown(r.result.recoupmentPctCentral);
      const runNew = (opts) => { const a = run(newLibs, cp.from, opts); return [a, cp.from === cp.to ? a : run(newLibs, cp.to, opts)]; };
      const unstatedAt = newOpts.creditBasis && t.creditBasis === 'unstated' && cp.label === 'at-recoup';
      let [newA, newB] = runNew(basisOpts(t.creditBasis !== 'post-credit' && !unstatedAt));
      let usedPost;
      if (unstatedAt && newA.result && newB.result) {
        const [preA, preB] = runNew(basisOpts(true));
        if (preA.result && preB.result) {
          const pick = eitherBasis({ ab: [preA, preB], err: windowError(c(preA), c(preB), range) }, { ab: [newA, newB], err: windowError(c(newA), c(newB), range) });
          [newA, newB] = pick.ab;
          usedPost = pick.usedPost;
        }
      }
      const okOld = oldA.result && oldB.result;
      const okNew = newA.result && newB.result;
      if (okOld && !okNew) { skipped.newOnly++; continue; }
      if (!okOld || !okNew) { skipped.noModel++; continue; }
      const disp = displayableAt({ comm, tier: newB.tier, result: newB.result, playedWeeks: weeks }, guard);
      if (displayableOnly && !disp) { skipped.notDisplayable++; continue; }
      rows.push({
        slug: key, kind: `timing:${cp.label}`, truthClass: t.truthClass, creditEra: creditEra(t.announcement.date), creditBasis: t.creditBasis, ...(usedPost !== undefined ? { usedPost } : {}), ...category(show),
        truth: [cp.lo, cp.hi], from: cp.from, to: cp.to, precision: t.announcement.precision,
        oldPct: c(oldB), newPct: c(newB), oldFrom: c(oldA), newFrom: c(newA), newLow: newB.result.recoupmentPctLow, newHigh: newB.result.recoupmentPctHigh,
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

// When to revisit RUNNING_MODEL_BAR_ENABLED (BRO-5073, coordinator 2026-10-11):
// at least 10 strong (at-recoup) displayable hard-truth rows with at least 80%
// inside, for plays and for musicals each. Weak "< 100" rows do not count.
const REVISIT_MIN_ROWS = 10;
const REVISIT_MIN_INSIDE = 0.8;
/** @returns {{ met: boolean, play: { n: number, inside: number }, musical: { n: number, inside: number } }} */
function revisitBar(rows) {
  const strong = rows.filter((r) => r.displayable && r.truthClass === 'reported' && r.kind === 'timing:at-recoup');
  const of = (type) => {
    const list = strong.filter((r) => (type === 'play' ? r.type === 'play' : r.type !== 'play'));
    return { n: list.length, inside: list.filter((r) => r.newErr === 0).length };
  };
  const play = of('play');
  const musical = of('musical');
  const ok = (g) => g.n >= REVISIT_MIN_ROWS && g.inside / g.n >= REVISIT_MIN_INSIDE;
  return { met: ok(play) && ok(musical), play, musical };
}

/**
 * Health-check verdict for the revisit bar (advisory, never 'error'): warn
 * when it is met, so the digest asks for a launch review; pass otherwise.
 * @param {{ revisitBar?: object, displayableHard?: number }|null} report the --timing --json output
 */
function revisitBarStatus(report) {
  const bar = report && report.revisitBar;
  if (!bar || !bar.play || !bar.musical) return { status: 'warn', message: 'Recoupment timing report missing or unreadable' };
  const counts = `plays ${bar.play.inside}/${bar.play.n} inside, musicals ${bar.musical.inside}/${bar.musical.n} (needs ${REVISIT_MIN_ROWS}+ rows and ${REVISIT_MIN_INSIDE * 100}%+ each)`;
  return bar.met
    ? { status: 'warn', message: `Revisit bar MET: ${counts}. Review RUNNING_MODEL_BAR_ENABLED with the owner (BRO-5073)` }
    : { status: 'pass', message: `Running-show bars stay off: ${counts}` };
}

function runTiming({ shows, commercial, lookup, by, baseLib, newLib, newOpts = {}, base, truth, displayableOnly, displayed, json, strict, aggregateOnly, markdown, lagWeeks = 0, crossing = false }) {
  if (crossing) return runCrossing({ commercial, lookup, by, newLibs: libsFrom(newLib), newOpts, truth, json, aggregateOnly });
  const { rows, skipped } = buildTimingRows({
    shows, commercial, lookup, by, oldLibs: libsFrom(baseLib), newLibs: libsFrom(newLib), newOpts, truth, displayableOnly, displayed, lagWeeks,
  });
  const MIN_GROUP = displayableOnly ? 3 : 1;
  const summary = summarize(rows);
  const worse = worseGroups(summary, { minN: MIN_GROUP });
  // A show the new side calls recouped 26 or 52 weeks before it did.
  const newEarly = newFalseRecouped(rows);
  const hardRows = rows.filter((r) => r.displayable && r.truthClass === 'reported');
  const displayableHard = hardRows.length;
  // Strong rows test a band at the announcement; weak rows only test "< 100".
  const split = (list) => `${list.length} rows, ${list.filter((r) => r.newErr === 0).length} inside, MAE ${list.length ? Math.round(list.reduce((a, r) => a + r.newErr, 0) / list.length * 10) / 10 : '-'}`;
  const strongWeak = `Displayable hard-truth split: strong (at-recoup 85-115) ${split(hardRows.filter((r) => r.kind === 'timing:at-recoup'))}; weak (< 100 before) ${split(hardRows.filter((r) => r.kind !== 'timing:at-recoup'))}`;
  const bar = revisitBar(rows);
  if (process.env.GITHUB_ACTIONS && bar.met) console.log('::notice title=Recoupment timing::revisit bar met; review RUNNING_MODEL_BAR_ENABLED (BRO-5073)');
  const optNames = Object.keys(newOpts);
  const label = `${base ? `${base} vs working tree` : 'working tree'}${optNames.length ? `, opts ${optNames.join(', ')}` : ''}, recoupment timing${lagWeeks ? `, announcement lag up to ${lagWeeks} wk` : ''}${displayableOnly ? ', displayable rows only' : ''}${displayed ? ', displayed value (floored at 0)' : ''}`;
  const lines = [
    `Truth set: ${truth === 'reported' ? `reported recoupment dates only, ${skipped.inference} inference records left out` : 'reported and inference'}`,
    `Recoupment-timing backtest, ${label}: ${rows.length} checkpoints (skipped ${Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`,
    `Displayable hard-truth checkpoints (would show a bar with the launch flag on): ${displayableHard}`,
    strongWeak,
    ...(newOpts.creditBasis ? [basisLine(rows)] : []),
    `Revisit bar for running-show bars (>= ${REVISIT_MIN_ROWS} strong rows, >= ${REVISIT_MIN_INSIDE * 100}% inside, plays and musicals each): ${bar.met ? 'MET' : 'not met'} (plays ${bar.play.inside}/${bar.play.n}, musicals ${bar.musical.inside}/${bar.musical.n})`,
    `Bias at recoupment (mean central - 100): old ${recoupBias(rows, 'old')}, new ${recoupBias(rows, 'new')}`,
    ...(lagWeeks ? [crossingLine(rows)] : [estimatedRecoupedLine(rows)]),
    `New early recouped (>= 100 at 26/52 weeks before): ${newEarly.length}${newEarly.length && !aggregateOnly ? ` (${newEarly.map((r) => `${r.slug} ${r.kind}`).join(', ')})` : ''}`,
  ];
  if (json) {
    console.log(JSON.stringify({ mode: 'timing', base: base || null, truth, summary, worse, skipped, displayableHard, revisitBar: bar, bias: { old: recoupBias(rows, 'old'), new: recoupBias(rows, 'new') }, ...(aggregateOnly ? {} : { rows }) }, null, 2));
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
        console.log(`  ${r.slug} [${r.kind} ${r.from}..${r.to}, truth ${fmtTruth(r.truth)} ${r.creditBasis}]: ${r.newFrom}..${r.newPct} (error ${Math.round(r.newErr * 10) / 10}; cap ${r.capitalization}, cost ${r.weeklyCost} ${r.costSource}, ${r.playedWeeks} wk${r.displayable ? ', displayable' : ''})`);
      }
    }
    console.log(worse.length ? `WORSE in: ${worse.join(', ')}` : `No group${MIN_GROUP > 1 ? ` of ${MIN_GROUP}+ rows` : ''} got worse.`);
  }
  if (strict && (worse.length || newEarly.length || skipped.newOnly)) process.exitCode = 1;
}

/**
 * With an announcement lag, a show passes when both ends hold: at least 85 at
 * the announcement and at most 115 at the lag start (the lag start is
 * missing when it falls before the first preview, then the announcement
 * alone decides). Counted per show, split plays / musicals.
 */
function crossingPass(rows) {
  const byShow = new Map();
  for (const r of rows) {
    if (r.kind !== 'timing:at-recoup' && r.kind !== 'timing:lag-start') continue;
    const e = byShow.get(r.slug) || { slug: r.slug, play: r.type === 'play', creditEra: r.creditEra, ok: true, strong: false };
    if (r.newErr !== 0) e.ok = false;
    if (r.kind === 'timing:at-recoup' && r.displayable) e.strong = true;
    byShow.set(r.slug, e);
  }
  return [...byShow.values()];
}
/**
 * Shadow display proposal (coordinator 2026-10-11): an unannounced running
 * show whose whole range is 100+ (low end >= 100) would read "Estimated to
 * have recouped, not yet announced" instead of being hidden. How often would
 * that fire at each checkpoint? At 26/52 weeks before an announcement it is
 * wrong unless the announcement lagged by that much.
 */
function estimatedRecoupedLine(rows) {
  const fire = (kind) => { const l = rows.filter((r) => r.kind === kind); return `${l.filter((r) => r.newLow >= 100).length}/${l.length}`; };
  return `Shadow "estimated recouped, not announced" (low end >= 100): at announcement ${fire('timing:at-recoup')}, 26 wk before ${fire('timing:26w-before')}, 52 wk before ${fire('timing:52w-before')}`;
}
function crossingLine(rows) {
  const all = crossingPass(rows);
  const part = (list) => `${list.filter((e) => e.ok).length}/${list.length}`;
  return `Crossing inside the lag window (>= 85 at announcement, <= 115 at lag start), per show: all ${part(all)}, plays ${part(all.filter((e) => e.play))}, musicals ${part(all.filter((e) => !e.play))}, credit era ${part(all.filter((e) => e.creditEra))}, pre-credit era ${part(all.filter((e) => !e.creditEra))}, displayable at announcement ${part(all.filter((e) => e.strong))}`;
}

const WEEK_MS = 7 * 86400000;
// A recoupment announced once the NY production credit existed could count
// it (the model's own program start); earlier ones could not.
const { TAX_CREDIT_PROGRAM_START } = require('./recoupment-model');
const creditEra = (date) => Date.parse(date) >= TAX_CREDIT_PROGRAM_START.getTime();
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

/**
 * When did the replayed model first read 100 or more? Scans week by week from
 * the first preview to 13 weeks past the announcement window (or closing),
 * pre-credit and with the credit as the model counts it. lead = weeks from
 * that crossing to the announcement window's end (+ means the model got there
 * first). Implied weeks of post-recoup profit at the announcement is the same
 * lead, read the other way.
 */
function crossingRows({ commercial, lookup, by, newLibs, newOpts = {}, truth = 'reported' }) {
  const out = [];
  for (const [key, rawComm] of Object.entries(commercial)) {
    if (rawComm.recouped !== true) continue;
    const show = by[key] || by[rawComm.slug] || by[key.replace(/-\d{4}$/, '')];
    const t = show && timingTruth(rawComm, show);
    if (!t || (truth === 'reported' && t.truthClass !== 'reported')) continue;
    const at = t.checkpoints.find((c) => c.label === 'at-recoup');
    const end = Date.parse(at ? at.to : t.announcement.date);
    const start = Date.parse(show.previewsStartDate || show.openingDate || '');
    if (!Number.isFinite(start)) continue;
    const close = show.closingDate ? Date.parse(show.closingDate) : Infinity;
    const comm = hideRecoupment(rawComm);
    const weekly = lookup.getWeeklyData(show.slug || show.id, show.id);
    const scan = (pre) => {
      let first = null; let atEnd = null;
      for (let d = start + 4 * WEEK_MS; d <= Math.min(end + 13 * WEEK_MS, close); d += WEEK_MS) {
        const day = new Date(d).toISOString().slice(0, 10);
        const cov = historyCoverage(weekly, show, day);
        if (cov.before > 0) return { thin: true };
        const r = modelAt(newLibs, show, comm, lookup, day, { ...newOpts, taxCreditPre: pre }).result;
        if (!r) continue;
        if (first === null && r.recoupmentPctCentral >= 100) first = d;
        if (d <= end) atEnd = r.recoupmentPctCentral;
      }
      return { lead: first === null ? null : Math.round((end - first) / WEEK_MS), atEnd: atEnd === null ? null : Math.round(atEnd) };
    };
    const pre = scan(true);
    if (pre.thin) continue;
    const post = scan(false);
    out.push({ slug: key, ...category(show), creditEra: creditEra(t.announcement.date), announcement: t.announcement.date, precision: t.announcement.precision, opening: show.openingDate || null, leadPre: pre.lead, leadPost: post.lead, atEndPre: pre.atEnd, atEndPost: post.atEnd });
  }
  return out;
}

function runCrossing({ commercial, lookup, by, newLibs, newOpts, truth, json, aggregateOnly }) {
  const rows = crossingRows({ commercial, lookup, by, newLibs, newOpts, truth });
  const stat = (list, k) => {
    const v = list.map((r) => r[k]).filter((x) => typeof x === 'number');
    return `n ${v.length}/${list.length}, median ${median(v)}, range ${v.length ? `${Math.min(...v)}..${Math.max(...v)}` : '-'}`;
  };
  const groups = { all: rows, plays: rows.filter((r) => r.type === 'play'), musicals: rows.filter((r) => r.type !== 'play'), 'credit era': rows.filter((r) => r.creditEra), 'pre-credit era': rows.filter((r) => !r.creditEra) };
  if (json) { console.log(JSON.stringify({ mode: 'crossing', groups: Object.fromEntries(Object.entries(groups).map(([g, l]) => [g, { pre: stat(l, 'leadPre'), post: stat(l, 'leadPost') }])), ...(aggregateOnly ? {} : { rows }) }, null, 2)); return; }
  console.log('Model lead: weeks from the model first reading 100+ to the recoupment announcement (+ = model first; never crossed = not counted)');
  for (const [g, l] of Object.entries(groups)) console.log(`${g.padEnd(15)} pre-credit ${stat(l, 'leadPre')}; with credit ${stat(l, 'leadPost')}`);
  if (aggregateOnly) return;
  for (const r of [...rows].sort((a, b) => (b.leadPre ?? -999) - (a.leadPre ?? -999))) {
    console.log(`  ${r.slug} [${r.type}, opened ${r.opening}, announced ${r.announcement} ${r.precision}]: lead pre ${r.leadPre ?? 'never'} wk (at announcement ${r.atEndPre}), with credit ${r.leadPost ?? 'never'} wk (${r.atEndPost})`);
  }
}

module.exports = { crossingRows, crossingPass, buildTimingRows, recoupBias, revisitBar, revisitBarStatus, runTiming, libsFrom, MIN_COVERAGE };
