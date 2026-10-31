#!/usr/bin/env node
/**
 * Leave-one-out backtest of the comparables capitalization (BRO-5849 step 4).
 * Every record with a DISCLOSED capitalization is re-run as if it had none:
 * the estimate is built from the pool without that record, the model runs on
 * it, and the result is scored against the same ground truth as
 * backtest-recoupment-ground-truth.js. This is the only place the guess meets
 * known answers. Advisory: it gates nothing.
 * Both model runs ignore reported outcomes to keep those answers out of the predictions.
 *
 * Usage: node scripts/backtest-cap-comparables.js [--json] [--truth=reported|all] [--type=musical|play] [--opt=<name>...]
 *
 * --type keeps one show type (BRO-5872: the musicals-only leave-one-out run).
 * --opt=<name> runs both sides with that shadow option on (the names
 * backtest-recoupment-ground-truth.js takes), so an option is scored on
 * guessed caps as well as disclosed ones.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeGrossesLookup } = require('./lib/grosses-lookup');
const { liveModelRun } = require('./lib/model-drift');
const { makeCapEstimator, isDisclosedCapitalization } = require('./lib/cap-comparables');
const { truthRows, rangeError, category, summarize } = require('./lib/recoupment-ground-truth');

const args = process.argv.slice(2);
const TRUTH = (args.find((a) => a.startsWith('--truth=')) || '--truth=all').slice(8);
const TYPE = (args.find((a) => a.startsWith('--type=')) || '').slice(7) || null;
// --opt=name or --opt=name=false, as backtest-recoupment-ground-truth.js takes them.
const OPTS = Object.fromEntries(args.filter((a) => a.startsWith('--opt=')).map((a) => a.slice(6).split('=')).map(([n, v]) => [n, v !== 'false']));
// A misspelt option would run as a no-op and read as "no change": it must be one scripts/lib reads.
const LIB = path.join(__dirname, 'lib');
const LIB_SRC = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n');
const unknown = Object.keys(OPTS).filter((n) => !/^\w+$/.test(n) || !new RegExp(`\\bopts\\.${n}\\b`).test(LIB_SRC));
if (unknown.length) { console.error(`Unknown --opt: ${unknown.join(', ')} (no scripts/lib module reads it)`); process.exit(2); }
const DATA = path.join(__dirname, '..', 'data');
const dataFile = (f) => (fs.existsSync(path.join(DATA, f)) ? path.join(DATA, f) : path.join(os.homedir(), 'broadway-scorecard-data', f));
const load = (f) => JSON.parse(fs.readFileSync(dataFile(f), 'utf8'));
const shows = Object.values(load('shows.json').shows);
const commercial = load('commercial.json').shows;
const L = makeGrossesLookup(load('grosses.json'), load('grosses-history.json'));
const by = {};
for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }

const capRows = [];
const pctRows = [];
for (const [key, comm] of Object.entries(commercial)) {
  const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
  if (!show || !isDisclosedCapitalization(comm)) continue;
  if (TYPE && !String(show.type || '').startsWith(TYPE)) continue;
  // The pool without this record.
  const est = makeCapEstimator(shows, commercial, (c) => c === comm || require('./lib/commercial-designations').hasNoInvestorsToRepay(c))(show, comm);
  if (!est) continue;
  const ratio = est.value / comm.capitalization;
  capRows.push({ slug: key, actual: comm.capitalization, est: est.value, ratio, inside: comm.capitalization >= est.low && comm.capitalization <= est.high, n: est.n, type: show.type });
  const bare = { ...comm }; delete bare.capitalization;
  const run = liveModelRun(show, bare, L, { ...OPTS, capComparables: true, capEstimator: () => est, ignoreReportedOutcome: true });
  const real = liveModelRun(show, comm, L, { ...OPTS, ignoreReportedOutcome: true });
  if (!run.result || !real.result) continue;
  for (const { truth, tier } of truthRows(comm, show, TRUTH)) {
    if (tier !== 'gate' && TRUTH === 'reported') continue;
    const o = real.result.recoupmentPctCentral; const n = run.result.recoupmentPctCentral;
    pctRows.push({ slug: key, kind: truth.kind, ...category(show), oldPct: o, newPct: n, oldErr: rangeError(o, truth), newErr: rangeError(n, truth),
      // The guess calls a not-recouped show recouped, or the reverse.
      flipped: (o >= 100) !== (n >= 100) });
  }
}
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const capSummary = {
  n: capRows.length,
  medianAbsLogError: median(capRows.map((r) => Math.abs(Math.log(r.ratio)))),
  within25pct: capRows.filter((r) => r.ratio >= 0.75 && r.ratio <= 1.25).length,
  within2x: capRows.filter((r) => r.ratio >= 0.5 && r.ratio <= 2).length,
  insideP10P90: capRows.filter((r) => r.inside).length,
};
const pctSummary = summarize(pctRows);
const flips = pctRows.filter((r) => r.flipped).length;
if (args.includes('--json')) { console.log(JSON.stringify({ capSummary, pctSummary, flips }, null, 2)); process.exit(0); }
console.log(`Leave-one-out cap estimate vs disclosed capitalization: ${capSummary.n} shows${TYPE ? ` (${TYPE}s only)` : ''}${Object.keys(OPTS).length ? `, opts ${Object.keys(OPTS).join(', ')}` : ''}`);
console.log(`  median |ln(est/actual)| ${capSummary.medianAbsLogError?.toFixed(2)} (0.29 = off by a third); within 25%: ${capSummary.within25pct}; within 2x: ${capSummary.within2x}; actual inside the estimate's P10-P90: ${capSummary.insideP10P90}`);
console.log('Model on the guess vs model on the disclosed cap, scored against ground truth (old = disclosed cap, new = comparables):');
console.log('group                n   old MAE  new MAE  old inside  new inside');
for (const [g, s] of Object.entries(pctSummary)) console.log(`${g.padEnd(20)} ${String(s.n).padStart(3)} ${String(s.oldMae).padStart(8)} ${String(s.newMae).padStart(8)} ${String(s.oldInside).padStart(11)} ${String(s.newInside).padStart(11)}`);
console.log(`Recouped/not-recouped flips caused by the guess: ${flips} of ${pctRows.length}`);
