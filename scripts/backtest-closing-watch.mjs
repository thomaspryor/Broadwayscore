#!/usr/bin/env node
/**
 * Closing Watch leave-one-show-out backtest (BRO-7254).
 *
 * The original BRO-7246 backtest scratch code was never committed, so its
 * 80-show / 12-false-alarm baseline cannot be reproduced. This script is the
 * replacement protocol, the one documented in
 * docs/audits/bro-7254-break-even-baseline.md, now reusable:
 *
 *   - gross weeks up to --cutoff (default 2026-11-09), market seasonal index
 *     over all shows (seasonalIndexSeries), current commercial.json values;
 *   - runs: every box-office-driven Broadway show (closed, open, previews)
 *     with a break-even, the same final-run and 2020-shutdown rules as
 *     getClosingWatchCalibration;
 *   - for each closed run: calibrate on every other run, walk its weeks, take
 *     the first week isOnClosingWatch flags it (closingDate cleared, since
 *     historical announcement dates are not on file) that gets a forecast;
 *   - in window: weeks to its last gross within [p25, p75] (null p75 = open);
 *   - false alarm: the show ran FALSE_ALARM_WEEKS (two years) or more after
 *     that forecast.
 *
 * It imports the production functions (closing-watch.ts, getBreakEven), so a
 * change to either moves the numbers. `breakEvenFor` lets a caller try a
 * different break-even per show without editing data.
 *
 * Usage: node scripts/backtest-closing-watch.mjs [--cutoff=YYYY-MM-DD] [--json] [--details]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/is-main-module.mjs';
const require = createRequire(import.meta.url);
require('tsx/cjs');
const cw = require('../src/lib/closing-watch.ts');
const { getBreakEven } = require('../src/lib/commercial-display.ts');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CUTOFF = '2026-11-09';
export const FALSE_ALARM_WEEKS = 104;
const COVID_SHUTDOWN = /^2020-03-/;

/** Paths of the three private data files the backtest reads. */
export function dataPaths(dataDir = path.join(ROOT, 'data')) {
  return {
    shows: path.join(dataDir, 'shows.json'),
    commercial: path.join(dataDir, 'commercial.json'),
    grosses: path.join(dataDir, 'grosses-history.json'),
  };
}

/** True when the private data is on disk (absent in public CI). */
export function hasBacktestData(dataDir) {
  return Object.values(dataPaths(dataDir)).every((p) => fs.existsSync(p));
}

export function loadBacktestInputs(dataDir) {
  const p = dataPaths(dataDir);
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  return { shows: read(p.shows).shows, commercial: read(p.commercial).shows, history: read(p.grosses).weeks };
}

/**
 * Runs the backtest. `breakEvenFor(slug, commercialRecord, show)` returns the
 * break-even to use (default: production getBreakEven).
 */
export function runClosingWatchBacktest(inputs, { cutoff = DEFAULT_CUTOFF, breakEvenFor = (_slug, comm) => getBreakEven(comm) } = {}) {
  const { shows, commercial, history } = inputs;
  const showBySlug = new Map(shows.map((s) => [s.slug, s]));
  const weeks = Object.keys(history).filter((w) => w <= cutoff).sort();
  const seasonal = cw.seasonalIndexSeries(weeks.map((w) => {
    const rows = Object.values(history[w]).filter((r) => r?.gross > 0);
    return rows.length ? rows.reduce((n, r) => n + r.gross, 0) / rows.length : null;
  }));

  const runs = [];
  for (const [slug, comm] of Object.entries(commercial)) {
    const show = showBySlug.get(slug);
    if (!show || !['closed', 'open', 'previews'].includes(show.status)) continue;
    if (!cw.isBoxOfficeDriven(comm.designation, show.limitedRun)) continue;
    const be = breakEvenFor(slug, comm, show);
    if (!(be > 0)) continue;
    let weekly = weeks.map((w) => history[w]?.[slug]?.gross ?? null);
    const last = weekly.findLastIndex((g) => g > 0);
    if (last < 0 || (show.status === 'closed' && COVID_SHUTDOWN.test(weeks[last]))) continue;
    if (show.status === 'closed') weekly = weekly.slice(0, last + 1);
    runs.push({
      slug, show, comm, be, weekly,
      ratios: cw.adjustedRatioSeries(weekly, seasonal, be),
      banked: cw.bankedShareSeries(weekly, be, comm.capitalization),
      closed: show.status === 'closed',
      start: cw.finalRunStart(weekly),
    });
  }

  const forecasts = [];
  for (const run of runs.filter((r) => r.closed)) {
    const calibration = cw.calibrateClosingWatch(runs.filter((r) => r !== run));
    for (let i = 0; i < run.ratios.length; i++) {
      const seen = run.weekly.slice(run.start, run.start + i + 1).filter((g) => g > 0).slice(-4);
      const avg = seen.reduce((a, b) => a + b, 0) / seen.length;
      if (!cw.isOnClosingWatch({
        status: 'open', designation: run.comm.designation, limitedRun: run.show.limitedRun,
        closingDate: null, today: weeks[run.start + i], avgGross: avg, breakEven: run.be, adjustedRatio: run.ratios[i],
      })) continue;
      const est = cw.estimateClosing(run.ratios.slice(0, i + 1), calibration, run.banked.slice(0, i + 1));
      if (!est) continue;
      const remaining = run.ratios.length - 1 - i;
      const inWindow = remaining >= (est.p25 ?? 0) && (est.p75 === null || remaining <= est.p75);
      forecasts.push({
        slug: run.slug, week: weeks[run.start + i], weeksRemaining: remaining,
        p25: est.p25, median: est.median, p75: est.p75, inWindow,
        miss: inWindow ? 0 : remaining < (est.p25 ?? 0) ? remaining - est.p25 : remaining - est.p75,
        breakEven: Math.round(run.be),
      });
      break;
    }
  }
  const inWindow = forecasts.filter((f) => f.inWindow).length;
  const falseAlarms = forecasts.filter((f) => f.weeksRemaining >= FALSE_ALARM_WEEKS);
  return {
    cutoff,
    runs: runs.length,
    closedRuns: runs.filter((r) => r.closed).length,
    forecasts: forecasts.length,
    inWindow,
    share: forecasts.length ? inWindow / forecasts.length : 0,
    falseAlarms: falseAlarms.length,
    falseAlarmSlugs: falseAlarms.map((f) => f.slug),
    details: forecasts,
  };
}

function main() {
  const args = process.argv.slice(2);
  const cutoff = (args.find((a) => a.startsWith('--cutoff=')) || '').split('=')[1] || DEFAULT_CUTOFF;
  if (!hasBacktestData()) {
    console.error('backtest-closing-watch: data/shows.json, commercial.json and grosses-history.json are required (npm run data:check).');
    process.exit(2);
  }
  const result = runClosingWatchBacktest(loadBacktestInputs(), { cutoff });
  if (!args.includes('--details')) delete result.details;
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Closing Watch backtest (cutoff ${result.cutoff}): ${result.runs} runs, ${result.closedRuns} closed`);
  console.log(`  in window: ${result.inWindow}/${result.forecasts} = ${(result.share * 100).toFixed(2)}%`);
  console.log(`  false alarms (ran ${FALSE_ALARM_WEEKS}+ weeks after the forecast): ${result.falseAlarms} ${result.falseAlarmSlugs.join(', ')}`);
  if (result.details) for (const d of result.details) console.log(`  ${d.inWindow ? 'IN ' : 'OUT'} ${d.slug} ${d.week} remaining=${d.weeksRemaining} window=${d.p25}-${d.p75} miss=${d.miss} be=${d.breakEven}`);
}

if (isMainModule(import.meta.url)) main();
