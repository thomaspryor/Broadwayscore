#!/usr/bin/env node
'use strict';

/**
 * backtest-recoupment-ground-truth.js — scores a recoupment-model change
 * against independently reported outcomes (scripts/lib/recoupment-ground-truth.js).
 * Runs the live model exactly as merge-model-recoupment.js does, then with
 * the given shadow options, and reports mean error and in-range counts,
 * overall and by kind, type (play/musical) and era (pre-2020/2020+).
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
 * --strict exits 1 when any group gets worse (higher mean error or fewer
 * inside the reported range).
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
const { groundTruth, rangeError, category, summarize, worseGroups, formatMarkdown, fmtTruth } = require('./lib/recoupment-ground-truth');
const { displaysModel, playedWeeks, MIN_PLAYED_WEEKS } = require('./lib/model-display-guard');

const KNOWN_OPTS = ['previewsFromWeekly', 'playedWeeksOnly', 'eraAdjust', 'taxCreditCitedOnly', 'datedCosts'];
const args = process.argv.slice(2);
const USAGE = `Usage: node scripts/backtest-recoupment-ground-truth.js (--opt=${KNOWN_OPTS.join('|')} [--opt=...] | --base=<git ref>) [--as-of-report] [--displayed] [--displayable-only] [--markdown] [--json] [--strict]`;
if (require('./lib/cli-help').hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
const names = args.filter((a) => a.startsWith('--opt=')).map((a) => a.slice(6));
const BASE = (args.find((a) => a.startsWith('--base=')) || '').slice(7);
if ((!names.length && !BASE) || names.some((n) => !KNOWN_OPTS.includes(n))) { console.error(USAGE); process.exit(2); }
const OPTS = Object.fromEntries(names.map((n) => [n, true]));
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
  return { run: require(path.join(lib, 'model-drift.js')).liveModelRun };
}
let baseRun = liveModelRun;
if (BASE) {
  const b = loadBaseModelRun(BASE);
  if (b.skip) { console.log(`Recoupment backtest skipped: ${b.skip}.`); process.exit(0); }
  baseRun = b.run;
}
// --displayed: score what an investor bar would show, which never goes below 0.
const DISPLAYED = args.includes('--displayed');
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

const rows = [];
const skipped = { noShow: 0, noModel: 0, notDisplayable: 0 };
for (const [key, comm] of Object.entries(commercial)) {
  const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
  if (!show) { skipped.noShow++; continue; }
  const truth = groundTruth(comm, show);
  if (!truth) continue;
  // --as-of-report: score a dated reported range against the model as it
  // stood on that date (both sides), so later grosses don't count against it.
  const at = AS_OF_REPORT && truth.asOf ? { asOf: truth.asOf } : {};
  if (DISPLAYABLE_ONLY && !(displaysModel(comm, show) && playedWeeks(show, at.asOf ? new Date(at.asOf) : new Date()) >= MIN_PLAYED_WEEKS)) {
    skipped.notDisplayable++;
    continue;
  }
  const live = baseRun(show, comm, L, at);
  const fixed = liveModelRun(show, comm, L, { ...OPTS, ...at });
  if (at.asOf && live.tier !== 'weekly-model') { skipped.noModel++; continue; }
  if (!live.result || !fixed.result) { skipped.noModel++; continue; }
  const oldPct = shown(live.result.recoupmentPctCentral);
  const newPct = shown(fixed.result.recoupmentPctCentral);
  rows.push({
    slug: key, kind: truth.kind, ...category(show),
    truth: [truth.lo, truth.hi], oldPct, newPct,
    oldErr: rangeError(oldPct, truth), newErr: rangeError(newPct, truth),
    source: truth.source.slice(0, 80), ...(at.asOf ? { asOf: at.asOf } : {}),
  });
}

const summary = summarize(rows);
const worse = worseGroups(summary, { minN: MIN_GROUP });
const label = [BASE && `${/^[0-9a-f]{40}$/.test(BASE) ? BASE.slice(0, 8) : BASE} vs working tree`, names.length && `opts ${names.join(', ')}`].filter(Boolean).join(', ');
const scope = `${AS_OF_REPORT ? ', dated ranges scored as of their report date' : ''}${DISPLAYED ? ', displayed value (floored at 0)' : ''}${DISPLAYABLE_ONLY ? ', displayable rows only' : ''}`;
if (process.env.GITHUB_ACTIONS && worse.length) console.log(`::warning title=Recoupment backtest::${label}${scope}: less accurate in ${worse.join(', ')}`);
if (args.includes('--json')) {
  console.log(JSON.stringify({ base: BASE || null, opts: OPTS, summary, worse, skipped, rows }, null, 2));
} else if (MARKDOWN) {
  console.log(formatMarkdown({ title: `Recoupment ground-truth backtest: ${label}${scope} (${rows.length} shows)`, summary, rows, worse }));
} else {
  console.log(`Ground-truth backtest, ${label}${scope}: ${rows.length} shows with a reported outcome and a model run (skipped ${skipped.noShow} unmatched, ${skipped.noModel} with no model run${DISPLAYABLE_ONLY ? `, ${skipped.notDisplayable} not displayable` : ''})`);
  console.log('group                n   old MAE  new MAE  old median  new median  old inside  new inside');
  for (const [g, s] of Object.entries(summary)) {
    console.log(`${g.padEnd(20)} ${String(s.n).padStart(3)}  ${String(s.oldMae).padStart(7)}  ${String(s.newMae).padStart(7)}  ${String(s.oldMedian).padStart(10)}  ${String(s.newMedian).padStart(10)}  ${String(s.oldInside).padStart(10)}  ${String(s.newInside).padStart(10)}`);
  }
  const moved = rows.filter((r) => r.oldErr !== r.newErr).sort((a, b) => Math.abs(b.newErr - b.oldErr) - Math.abs(a.newErr - a.oldErr));
  console.log(`Error changed on ${moved.length}:`);
  const listed = DISPLAYABLE_ONLY && rows.length < 10 ? rows : moved.slice(0, 15);
  if (listed === rows) console.log(`Under 10 displayable rows, so every row:`);
  for (const r of listed) {
    const t = fmtTruth(r.truth);
    console.log(`  ${r.slug} [${r.kind}, truth ${t}]: ${r.oldPct} -> ${r.newPct} (error ${Math.round(r.oldErr * 10) / 10} -> ${Math.round(r.newErr * 10) / 10})`);
  }
  console.log(worse.length ? `WORSE in: ${worse.join(', ')}` : `No group${MIN_GROUP > 1 ? ` of ${MIN_GROUP}+ rows` : ''} got worse.`);
}
if (args.includes('--strict') && worse.length) process.exit(1);
