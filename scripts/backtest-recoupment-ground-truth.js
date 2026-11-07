#!/usr/bin/env node
'use strict';

/**
 * backtest-recoupment-ground-truth.js — scores a recoupment-model change
 * against independently reported outcomes (scripts/lib/recoupment-ground-truth.js).
 * Runs the live model exactly as merge-model-recoupment.js does, then with
 * the given shadow options, and reports mean error and in-range counts,
 * overall and by kind, type (play/musical) and era (pre-2020/2020+).
 * Both sides use ignoreReportedOutcome so reported losses cannot constrain the predictions scored against them.
 * Read-only. Run it for every model change before a live switch.
 *
 *   node scripts/backtest-recoupment-ground-truth.js --opt=previewsFromWeekly [--opt=...] [--json] [--strict]
 *   node scripts/backtest-recoupment-ground-truth.js --base=<git ref> [--markdown]
 *
 * --base=<ref> compares code instead of options: the old side is the model
 * as of <ref> (its scripts/lib and cost index, extracted to a temp dir), the
 * new side is the working tree. test.yml runs it on every push (advisory,
 * BRO-4989 checker #6). A base with no model-drift.js is skipped, exit 0.
 * --markdown prints the report as GitHub markdown (CI step summary).
 *
 * --truth=reported (default) scores only rows a trade outlet, the producers or
 * a filing stated (truthClass in the lib); --truth=all adds Reddit, deep
 * research and our own synthesis. The excluded count is printed. Under the
 * default the inference rows are still scored, on their own Advisory line
 * (owner 2026-10-13): they never count toward --strict or the CI annotations.
 * --timing has no Advisory line: it leaves inference rows out and says so.
 *
 * Two lines gate any shadow-to-live switch (checker, 2026-10-10):
 *   New false recouped: rows the truth says never recouped that the new side
 *     puts at >= 100% while the old side did not. --strict exits 1 on any.
 *   Sanity: every record (truth or not) whose model central is below -500%,
 *     or above 500% while not marked recouped, on either side: a sign of a
 *     broken input (Cabaret's -735).
 *
 * Near-miss losers (BRO-6191, advisory, never gates): failed-truth rows whose new central is >= 90% while old was below, and records
 *   with no outcome on file crossing 100%. Logic: lib/near-miss-losers.js.
 *
 * --strict exits 1 when any group gets worse (higher mean error or fewer
 * inside the reported range) or on any new false recouped.
 * --displayable-only keeps the rows the site would show a model bar for
 * (display mode 'model' and at least 12 played weeks, as of the report date
 * with --as-of-report); groups under 3 rows are listed but not gated there,
 * and a set under 10 rows is printed in full.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { liveModelRun } = require('./lib/model-drift');
const { makeGrossesLookup } = require('./lib/grosses-lookup');
const { execFileSync } = require('child_process');
const { eitherBasis, basisLine, rangeError, category, summarize, worseGroups, truthRows, newFalseRecouped: falseRecoupedRows, advisoryLine, formatMarkdown, fmtTruth } = require('./lib/recoupment-ground-truth');
const { nearMissLosers, unsourcedCrossings, nearMissLine, noOutcomeOnFile } = require('./lib/near-miss-losers');
const { displaysModel, playedWeeks, MIN_PLAYED_WEEKS } = require('./lib/model-display-guard');

const KNOWN_OPTS = ['previewsFromWeekly', 'playedWeeksOnly', 'eraAdjust', 'taxCreditCitedOnly', 'datedCosts', 'ownRunOnly', 'costSplit', 'stepSmall', 'stepLate', 'costGrowth', 'reserveLag', 'creditBasis', 'varBand', 'varOverage', 'varBandMusicals', 'varOverageMusicals', 'varBandMusicalsRamp', 'varBandMusicalsCited', 'noReserve', 'reserveIfStated', 'costSourcedOnly', 'svogCredit', 'costBasis', 'sourcedStarDeals', 'impliedCost', 'eraIndex', 'capMaxHaircut', 'capComparables', 'varBandMusicalsWaltz', 'varBandMusicalsReported', 'capScaledMusicals'];
const args = process.argv.slice(2);
const USAGE = `Usage: node scripts/backtest-recoupment-ground-truth.js (--opt=${KNOWN_OPTS.join('|')}[=false] [--opt=...] | --base=<git ref> | --timing [--lag=<weeks>] [--crossing]) [--truth=reported|all] [--as-of-report] [--displayed] [--displayable-only] [--markdown] [--json] [--strict]`;
if (require('./lib/cli-help').hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
// --opt=name turns an option on; --opt=name=false turns off one that is live by
// default (MUSICAL_LIVE_OPTS, BRO-5598, or PLAY_LIVE_OPTS, BRO-5607/5651, in
// lib/recoupment-model.js).
const optArgs = args.filter((a) => a.startsWith('--opt=')).map((a) => a.slice(6).split('='));
const names = optArgs.map(([n]) => n);
const BASE = (args.find((a) => a.startsWith('--base=')) || '').slice(7);
const TRUTH = (args.find((a) => a.startsWith('--truth=')) || '--truth=reported').slice(8);
const TIMING = args.includes('--timing');
if ((!names.length && !BASE && !TIMING) || optArgs.some(([n, v]) => !KNOWN_OPTS.includes(n) || ![undefined, 'true', 'false'].includes(v)) || !['reported', 'all'].includes(TRUTH)) { console.error(USAGE); process.exit(2); }
const OPTS = Object.fromEntries(optArgs.map(([n, v]) => [n, v !== 'false']));
const AS_OF_REPORT = args.includes('--as-of-report');
const MARKDOWN = args.includes('--markdown');
const REPO = path.join(__dirname, '..');

// The model as of a git ref. Its scripts/lib and data/broadway-cost-index.json
// go to a temp dir together, so cost-for-week.js's __dirname/../../data finds
// the base's own index (a cost-index change then shows up as a delta).
function loadBaseModelRun(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-base-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const extract = (p) => execFileSync('bash', ['-c', 'set -o pipefail; git archive "$1" -- "$2" | tar -x -C "$3"', '_', ref, p, dir], { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] });
  extract('scripts/lib');
  try { extract('data/broadway-cost-index.json'); } catch { /* base predates the index */ }
  const lib = path.join(dir, 'scripts', 'lib');
  if (!fs.existsSync(path.join(lib, 'model-drift.js'))) return { skip: `base ${ref} predates model-drift.js` };
  // A base model without asOf would score "now" against a new side scored as of the report.
  if (AS_OF_REPORT && !/\basOf\b/.test(fs.readFileSync(path.join(lib, 'recoupment-model.js'), 'utf8'))) return { skip: `base ${ref} model has no asOf option` };
  return { run: require(path.join(lib, 'model-drift.js')).liveModelRun, lib };
}
let baseRun = liveModelRun;
let baseLib = path.join(__dirname, 'lib');
if (BASE) {
  const b = loadBaseModelRun(BASE);
  if (b.skip) { console.log(`Recoupment backtest skipped: ${b.skip}.`); process.exit(0); }
  baseRun = b.run;
  baseLib = b.lib;
}
// --displayed: score what an investor bar would show, which never goes below 0.
const DISPLAYED = args.includes('--displayed');
// The repo is public, so a GitHub Actions log or step summary is world-readable:
// there the output is aggregates only, never a show name or a per-show number
// (commercial.json is private core data).
const AGGREGATE_ONLY = !!process.env.GITHUB_ACTIONS || args.includes('--aggregate-only');
const shown = (pct) => (DISPLAYED ? Math.max(0, pct) : pct);
const DISPLAYABLE_ONLY = args.includes('--displayable-only');
const MIN_GROUP = DISPLAYABLE_ONLY ? 3 : 1;

const DATA = path.join(__dirname, '..', 'data');
const dataFile = (f) => (fs.existsSync(path.join(DATA, f)) ? path.join(DATA, f) : path.join(os.homedir(), 'broadway-scorecard-data', f));
const load = (f) => JSON.parse(fs.readFileSync(dataFile(f), 'utf8'));

const shows = Object.values(load('shows.json').shows);
const commercial = load('commercial.json').shows;
const L = makeGrossesLookup(load('grosses.json'), load('grosses-history.json'));
const by = {};
for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }
// --opt=capComparables (BRO-5849): a record with no capitalization runs on a comparables figure.
// Live since BRO-5849 (merge-model-recoupment.js, model-drift.js). The scored rows keep their
// established basis (a cap-less record is skipped, and the MAE gates in musical-model-backtest.test.mjs
// rest on it); only the advisory near-miss line also runs the cap-less records with it (Misery 2015
// reads 57 -> 97 at a 450K star-play default), unless --opt=capComparables=false (BRO-6191).
const CAP_OPTS = OPTS.capComparables === false ? {} : { capComparables: true, capEstimator: require('./lib/cap-comparables').makeCapEstimator(shows, commercial) };

if (TIMING) {
  require('./lib/recoupment-timing-report').runTiming({
    shows, commercial, lookup: L, by, baseLib, newLib: path.join(__dirname, 'lib'), newOpts: OPTS, base: BASE, truth: TRUTH,
    displayableOnly: DISPLAYABLE_ONLY, displayed: DISPLAYED, json: args.includes('--json'), strict: args.includes('--strict'),
    aggregateOnly: AGGREGATE_ONLY, markdown: MARKDOWN,
    lagWeeks: Number((args.find((a) => a.startsWith('--lag=')) || '--lag=0').slice(6)) || 0, crossing: args.includes('--crossing'),
  });
  // Not process.exit(): it truncates piped stdout at 64KB (the --json rows), BRO-6184.
  return;
}

const rows = [];
const advisoryRows = [];
const skipped = { noShow: 0, noModel: 0, notDisplayable: 0, inference: 0, newOnly: 0 };
// Advisory rows' skips are their own, so a model gap there never blocks.
const advisorySkipped = { noModel: 0, notDisplayable: 0, newOnly: 0, superseded: 0 };
const SANITY_LIMIT = 500;
const insane = [];
const capOnlyLosers = []; // failed-truth rows only a comparables cap lets the model run (near-miss line only)
const unsourced = []; // records with no outcome on file: old/new central, for the near-miss line (BRO-6191)
for (const [key, comm] of Object.entries(commercial)) {
  const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
  if (!show) { skipped.noShow++; continue; }
  const truthList = truthRows(comm, show, TRUTH);
  if (!truthList.length) { sanityCheck(key, show, comm); continue; }
  for (const { truth, tier, superseded } of truthList) {
  const advisory = tier === 'advisory';
  const skip = advisory ? advisorySkipped : skipped;
  // Sanity covers advisory records exactly as before they were scored.
  if (advisory && !superseded) { skipped.inference++; sanityCheck(key, show, comm); }
  if (superseded) advisorySkipped.superseded++;
  // --as-of-report: score a dated reported range against the model as it
  // stood on that date (both sides), so later grosses don't count against it.
  const at = AS_OF_REPORT && truth.asOf ? { asOf: truth.asOf } : {};
  if (DISPLAYABLE_ONLY && !(displaysModel(comm, show) && playedWeeks(show, at.asOf ? new Date(at.asOf) : new Date()) >= MIN_PLAYED_WEEKS)) {
    skip.notDisplayable++;
    continue;
  }
  const live = baseRun(show, comm, L, { ...at, ignoreReportedOutcome: true });
  // --opt=creditBasis: score the new side on the truth's tax-credit basis;
  // an unstated recoupment is scored on whichever basis fits (eitherBasis).
  const runBasis = (pre) => liveModelRun(show, comm, L, { ...OPTS, ...(OPTS.creditBasis ? { taxCreditPre: pre } : {}), ...at, ignoreReportedOutcome: true });
  let fixed = runBasis(truth.creditBasis === 'pre-credit');
  let usedPost;
  if (OPTS.creditBasis && truth.creditBasis === 'unstated' && fixed.result) {
    const pre = runBasis(true);
    if (pre.result) {
      const err = (f) => rangeError(shown(f.result.recoupmentPctCentral), truth);
      const pick = eitherBasis({ run: pre, err: err(pre) }, { run: fixed, err: err(fixed) });
      fixed = pick.run;
      usedPost = pick.usedPost;
    }
  }
  if (at.asOf && live.tier !== 'weekly-model') { skip.noModel++; continue; }
  if (truth.kind === 'failed' && (!live.result || !fixed.result)) capOnlyLosers.push(...capFilledRow(key, show, comm, at, truth.kind));
  // A row only the new side fails is a regression, not a skip: counted and blocking.
  if (live.result && !fixed.result) { skip.newOnly++; continue; }
  if (!live.result || !fixed.result) { skip.noModel++; continue; }
  if (!advisory) flagInsane(key, live.result.recoupmentPctCentral, fixed.result.recoupmentPctCentral);
  const oldPct = shown(live.result.recoupmentPctCentral);
  const newPct = shown(fixed.result.recoupmentPctCentral);
  (advisory ? advisoryRows : rows).push({
    slug: key, kind: truth.kind, truthClass: truth.truthClass, creditBasis: truth.creditBasis, ...(usedPost !== undefined ? { usedPost } : {}), ...category(show),
    truth: [truth.lo, truth.hi], oldPct, newPct,
    oldErr: rangeError(oldPct, truth), newErr: rangeError(newPct, truth),
    source: truth.source.slice(0, 80), ...(at.asOf ? { asOf: at.asOf } : {}), ...(superseded ? { superseded } : {}),
  });
  }
}

// A recouped long-runner legitimately returns many times its capitalization
// (Hamilton is past 15,000%), so only a show not marked recouped is flagged high.
function flagInsane(slug, oldPct, newPct) {
  const recouped = commercial[slug] && commercial[slug].recouped === true;
  const bad = (v) => typeof v === 'number' && (v < -SANITY_LIMIT || (v > SANITY_LIMIT && !recouped));
  if (bad(oldPct) || bad(newPct)) insane.push({ slug, oldPct, newPct });
}
// Records that are not scored still run through the model for the sanity line.
function sanityCheck(slug, show, comm) {
  const o = baseRun(show, comm, L, { ignoreReportedOutcome: true });
  const n = liveModelRun(show, comm, L, { ...OPTS, ignoreReportedOutcome: true });
  flagInsane(slug, o.result && o.result.recoupmentPctCentral, n.result && n.result.recoupmentPctCentral);
  if (!noOutcomeOnFile(comm)) return;
  const capped = o.result && n.result ? { o, n } : capRuns(show, comm, {});
  if (capped) unsourced.push({ slug, oldPct: shown(capped.o.result.recoupmentPctCentral), newPct: shown(capped.n.result.recoupmentPctCentral) });
}
// Both sides on the live comparables cap; null when either still has no result.
function capRuns(show, comm, at) {
  if (!CAP_OPTS.capComparables) return null;
  const o = baseRun(show, comm, L, { ...CAP_OPTS, ...at, ignoreReportedOutcome: true });
  const n = liveModelRun(show, comm, L, { ...CAP_OPTS, ...OPTS, ...at, ignoreReportedOutcome: true });
  return o.result && n.result ? { o, n } : null;
}
function capFilledRow(slug, show, comm, at, kind) {
  const c = capRuns(show, comm, at);
  return c ? [{ slug, kind, oldPct: shown(c.o.result.recoupmentPctCentral), newPct: shown(c.n.result.recoupmentPctCentral) }] : [];
}

// A truth that says "never recouped" (failed, or a reported range under 100)
// that only the new side calls recouped.
const newFalseRecouped = falseRecoupedRows(rows);
const detail = (list, fmt) => (list.length && !AGGREGATE_ONLY ? ` (${list.map(fmt).join(', ')})` : '');
const falseRecoupedLine = `New false recouped vs truth: ${newFalseRecouped.length}${detail(newFalseRecouped, (r) => `${r.slug} ${r.oldPct} -> ${r.newPct}`)}${newFalseRecouped.length ? '; blocks any switch' : ''}`;
const nearMiss = nearMissLosers(rows.concat(advisoryRows, capOnlyLosers));
const nearMissOut = nearMissLine(nearMiss, unsourcedCrossings(unsourced), { names: !AGGREGATE_ONLY });
const sanityLine = `Sanity, model central below -${SANITY_LIMIT}% (or above ${SANITY_LIMIT}% while not recouped): ${insane.length}${detail(insane, (r) => `${r.slug} ${r.oldPct} -> ${r.newPct}`)}`;
const newOnlyLine = `Rows only the new side failed to model: ${skipped.newOnly}${skipped.newOnly ? '; blocks any switch' : ''}`;
const truthLine = `Truth set: ${TRUTH === 'reported' ? `reported rows decide pass or fail; ${skipped.inference} inference-only records go to the Advisory line instead (--truth=all mixes them in)` : 'reported and inference'}`;
// --truth=all prints it too when a reported claim displaced an inference % (BRO-5264 retro-review).
const showAdvisory = TRUTH === 'reported' || advisorySkipped.superseded > 0;
const advisoryOut = showAdvisory ? `${advisoryLine(advisoryRows, { minN: MIN_GROUP })}; of ${skipped.inference + advisorySkipped.superseded} (${advisorySkipped.superseded} an inference % a reported claim displaced), skipped ${advisorySkipped.noModel} with no model run${DISPLAYABLE_ONLY ? `, ${advisorySkipped.notDisplayable} not displayable` : ''}, ${advisorySkipped.newOnly} only the new side failed to model` : null;

const summary = summarize(rows);
const worse = worseGroups(summary, { minN: MIN_GROUP });
const label = [BASE && `${/^[0-9a-f]{40}$/.test(BASE) ? BASE.slice(0, 8) : BASE} vs working tree`, names.length && `opts ${names.join(', ')}`].filter(Boolean).join(', ');
const scope = `${AS_OF_REPORT ? ', dated ranges scored as of their report date' : ''}${DISPLAYED ? ', displayed value (floored at 0)' : ''}${DISPLAYABLE_ONLY ? ', displayable rows only' : ''}`;
if (process.env.GITHUB_ACTIONS && worse.length) console.log(`::warning title=Recoupment backtest::${label}${scope}: less accurate in ${worse.join(', ')}`);
if (process.env.GITHUB_ACTIONS && (newFalseRecouped.length || skipped.newOnly)) console.log(`::error title=Recoupment backtest::${label}${scope}: ${falseRecoupedLine}; ${newOnlyLine}`);
if (args.includes('--json')) {
  const nearMissJson = { nearMissLosers: AGGREGATE_ONLY ? nearMiss.length : nearMiss, unsourcedCrossings: AGGREGATE_ONLY ? unsourcedCrossings(unsourced).length : unsourcedCrossings(unsourced) };
  const detailOut = AGGREGATE_ONLY ? { newFalseRecouped: newFalseRecouped.length, insane: insane.length, ...nearMissJson } : { newFalseRecouped, insane, rows, ...nearMissJson };
  const advisoryJson = showAdvisory ? { advisory: { line: advisoryOut, summary: summarize(advisoryRows), skipped: advisorySkipped, ...(AGGREGATE_ONLY ? {} : { rows: advisoryRows }) } } : {};
  console.log(JSON.stringify({ base: BASE || null, opts: OPTS, truth: TRUTH, summary, worse, skipped, ...detailOut, ...advisoryJson }, null, 2));
} else if (MARKDOWN) {
  console.log(formatMarkdown({ title: `Recoupment ground-truth backtest: ${label}${scope} (${rows.length} shows)`, summary, rows, worse, aggregateOnly: AGGREGATE_ONLY }));
  console.log([truthLine, ...(OPTS.creditBasis ? [basisLine(rows)] : []), `**${falseRecoupedLine}**`, nearMissOut, `**${newOnlyLine}**`, sanityLine, ...(advisoryOut ? [advisoryOut] : []), ''].join('\n\n'));
} else {
  console.log(truthLine);
  if (OPTS.creditBasis) console.log(basisLine(rows));
  console.log(`Ground-truth backtest, ${label}${scope}: ${rows.length} shows with a reported outcome and a model run (skipped ${skipped.noShow} unmatched, ${skipped.noModel} with no model run${DISPLAYABLE_ONLY ? `, ${skipped.notDisplayable} not displayable` : ''})`);
  console.log('group                n   old MAE  new MAE  old median  new median  old inside  new inside');
  for (const [g, s] of Object.entries(summary)) {
    console.log(`${g.padEnd(20)} ${String(s.n).padStart(3)}  ${String(s.oldMae).padStart(7)}  ${String(s.newMae).padStart(7)}  ${String(s.oldMedian).padStart(10)}  ${String(s.newMedian).padStart(10)}  ${String(s.oldInside).padStart(10)}  ${String(s.newInside).padStart(10)}`);
  }
  const moved = rows.filter((r) => r.oldErr !== r.newErr).sort((a, b) => Math.abs(b.newErr - b.oldErr) - Math.abs(a.newErr - a.oldErr));
  console.log(`Error changed on ${moved.length}:`);
  const listed = DISPLAYABLE_ONLY && rows.length < 10 ? rows : moved.slice(0, 15);
  if (listed === rows) console.log(`Under 10 displayable rows, so every row:`);
  for (const r of AGGREGATE_ONLY ? [] : listed) {
    const t = fmtTruth(r.truth);
    console.log(`  ${r.slug} [${r.kind}, truth ${t} ${r.creditBasis}]: ${r.oldPct} -> ${r.newPct} (error ${Math.round(r.oldErr * 10) / 10} -> ${Math.round(r.newErr * 10) / 10})`);
  }
  console.log(worse.length ? `WORSE in: ${worse.join(', ')}` : `No group${MIN_GROUP > 1 ? ` of ${MIN_GROUP}+ rows` : ''} got worse.`);
  console.log(falseRecoupedLine);
  console.log(nearMissOut);
  console.log(newOnlyLine);
  console.log(sanityLine);
  if (advisoryOut) console.log(advisoryOut);
}
if (args.includes('--strict') && (worse.length || newFalseRecouped.length || skipped.newOnly)) process.exitCode = 1;
