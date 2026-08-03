#!/usr/bin/env node
/**
 * coverage-adversarial-probe.js — Coverage Verdict S5 (task #903, FINAL
 * sprint): the seeded weekly adversarial check that proves the coverage
 * pipeline, not just measures it.
 *
 * Why "seeded adversarial" and not "owner spot-checked": a check that passes
 * because a human looked and found nothing passes vacuously the moment the
 * human stops looking (the exact #872 failure mode — four consecutive
 * owner spot-checks in a row found reviews the census had reported absent).
 * This script instead picks shows the OPERATOR did not choose — 5 random
 * shows from the last ~45 days of openings — runs the same naive Google
 * query a human would type (S1's harness, buildNaiveCensusQuery +
 * acceptSerpCensusResult, reused verbatim — this is deliberately NOT a new
 * SERP path per the plan's "no new parallel machinery" rule), and asserts
 * every discovered review URL is either:
 *   live      — on disk in review-texts/ AND isIncludableForRebuild()
 *   excluded  — on disk but explainExclusion() names the rule keeping it out
 * A URL that is neither is a GAP: a real, current review the pipeline has
 * not yet found, discovered fresh by an adversary that does not know which
 * shows the pipeline already trusts.
 *
 * Cost posture: 5 shows/week x 1 naive-query page = ~5 SERP calls, through
 * the same budgeted BD/SD/SB chain as S1's recall harness (24h disk cache).
 *
 * Never hard-fails by default — the plan is explicit that probe failures
 * surface in the daily digest, never as email spam or a red CI run holding up
 * unrelated merges (the same posture audit-serp-census-recall.js takes for
 * regressions). `--fail-on-gap` is an opt-in for a caller that wants CI to go
 * red on a real finding.
 *
 * "Two consecutive clean weeks = done" is judged by
 * scripts/lib/coverage-adversarial-probe.js's evaluateAcceptance() over the
 * trend ledger this CLI appends to — see that module's header for why an
 * outage week must never manufacture a false pass.
 *
 * Kill switches: ADVERSARIAL_PROBE_DISABLED=1 (this cadence's own) and
 * SERP_GAP_CENSUS_DISABLED=1 (the census-wide switch lib/serp-review-census.js
 * already honours) both exit 0 without spending a SERP call.
 *
 * Usage:
 *   node scripts/coverage-adversarial-probe.js --sample=5
 *   node scripts/coverage-adversarial-probe.js --sample=5 --trend       # the cron shape
 *   node scripts/coverage-adversarial-probe.js --sample=5 --seed=42     # deterministic (tests)
 *
 * Output: data/audit/coverage-adversarial-probe.json (latest run detail),
 *         data/audit/coverage-adversarial-probe-trend.jsonl (--trend),
 *         data/audit/coverage-adversarial-probe-status.json (--trend)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { serpQuery, calculateDateWindow, getShowInfo } = require('./lib/url-discovery');
const { buildNaiveCensusQuery, censusGeoFor } = require('./lib/serp-review-census');
const { acceptSerpCensusResult, normalizeReviewUrl, isReviewUrl } = require('./audit-show-review-gap.js');
const { isIncludableForRebuild, explainExclusion } = require('./lib/review-guards');
const { classifySample } = require('./lib/census-recall.js');
const { classifyCandidate, summarizeShow, summarizeRun, evaluateAcceptance } = require('./lib/coverage-adversarial-probe.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { loadEnv } = require('./lib/load-env.js');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const OUT_PATH = path.join(AUDIT_DIR, 'coverage-adversarial-probe.json');
const TREND_PATH = path.join(AUDIT_DIR, 'coverage-adversarial-probe-trend.jsonl');
const STATUS_PATH = path.join(AUDIT_DIR, 'coverage-adversarial-probe-status.json');

const DEFAULT_SAMPLE = 5;
const DEFAULT_DAYS = 45;
const DEFAULT_PAGES = 1;
/** A year of weekly runs — matches census-recall-trend.jsonl's own cap. */
const TREND_MAX_ENTRIES = 52;

const USAGE = `Usage: node scripts/coverage-adversarial-probe.js [options]

Seeded weekly adversarial check (Coverage Verdict S5, task #903): runs the
naive Google query against 5 random recent openings and asserts every
discovered review URL is live-or-named-excluded.

Options:
  --sample=N        Shows to sample (default ${DEFAULT_SAMPLE})
  --days=N          Pool = shows opened within the last N days (default ${DEFAULT_DAYS})
  --pages=N         Naive-query pages to read per show (default ${DEFAULT_PAGES})
  --shows=a,b,c     Probe these show IDs instead of a random sample (testing)
  --seed=N          Deterministic sample selection (testing/reproduction)
  --settling-hours=N Shows opened within N hours are 'settling', excluded (default 24)
  --trend           Append this run to the trend ledger and judge the
                    "two consecutive clean weeks" acceptance bar
  --fail-on-gap     Exit 1 when this run found any real gap (off by default —
                    findings surface via the digest, never as a red CI run)
  --out=PATH        Override report path
  --help, -h        Show this message

Kill switches: ADVERSARIAL_PROBE_DISABLED=1, SERP_GAP_CENSUS_DISABLED=1.`;

const args = process.argv.slice(2);
function getArg(name, dflt = null) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const hasFlag = (name) => args.includes(`--${name}`);

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

/** Deterministic PRNG (mulberry32) so --seed makes the sample reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The ADVERSARY'S sample: shows the operator did not choose. Random, not
 * "most recent" — the recall harness (S1) already covers "most recent
 * openings" on its own schedule; this cadence's whole point is to be a
 * different, unpredictable slice each week.
 */
function pickSample(shows, opts = {}) {
  const explicit = opts.showIds;
  if (explicit) {
    const ids = String(explicit).split(',').map(s => s.trim()).filter(Boolean);
    return ids.map(id => shows.find(s => s.id === id)).filter(Boolean);
  }
  const days = opts.days === undefined ? DEFAULT_DAYS : opts.days;
  const sample = opts.sample === undefined ? DEFAULT_SAMPLE : opts.sample;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const cutoff = now - days * 86400000;
  const pool = shows.filter(s => s.openingDate && Date.parse(s.openingDate) >= cutoff && Date.parse(s.openingDate) <= now);
  const rand = opts.seed !== undefined ? mulberry32(Number(opts.seed)) : Math.random;
  return shuffle(pool, rand).slice(0, sample);
}

/** Every review-texts record for a show, keyed by normalized URL, for the
 * live-vs-excluded-vs-gap classification. ALSO includes
 * data/review-texts/_pending/<showId>/ quarantined files (marked
 * `pending: true`): a review the write-guard correctly quarantined
 * (date-implausible, prior-production) is a named exclusion the probe
 * already knows about, not an unaccounted gap (task #907: the-state-of-
 * the-arts Car Man case — a 2015 prior-production review, correctly
 * quarantined by the #832 date guard, read as a silent gap before this). */
function onDiskByUrlFor(showId) {
  const map = new Map();
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { entries = []; }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const filePath = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    const u = data && data.url;
    if (u && isReviewUrl(u)) map.set(normalizeReviewUrl(u), { data, filePath });
  }
  const pendingDir = path.join(REVIEW_TEXTS_DIR, '_pending', showId);
  let pendingEntries;
  try { pendingEntries = fs.readdirSync(pendingDir); } catch { pendingEntries = []; }
  for (const f of pendingEntries) {
    if (!f.endsWith('.json')) continue;
    const filePath = path.join(pendingDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    const u = data && data.url;
    if (!u || !isReviewUrl(u)) continue;
    const key = normalizeReviewUrl(u);
    // A live/on-disk record for the same URL always wins over a pending
    // one — pending quarantine is a fallback classification, not an
    // override of an already-scored file.
    if (map.has(key)) continue;
    map.set(key, { data, filePath, pending: true, pendingReason: data.pendingReason || null });
  }
  return map;
}

async function probeOneShow(show, { pages, now, settlingHours }) {
  const sample = classifySample(show, { now, settlingHours });
  const row = {
    showId: show.id,
    title: show.title,
    openingDate: show.openingDate || null,
    sampleState: sample.state,
    sampleReason: sample.reason,
    naiveQuery: null,
    candidates: [],
    // {ok, raw} per naive-query attempt — detectProviderOutage's evidence
    // that this run actually reached a live SERP provider (Codex ship-check
    // finding: a swallowed exception must not read the same as "nothing to
    // find", which summarizeShow() otherwise treats as a trivial pass).
    queries: [],
    // Size of the on-disk review-texts map for this show — onDiskUnavailable's
    // evidence that the corpus checkout was actually present (Codex
    // ship-check finding: an empty checkout must not read as "everything is
    // a gap").
    onDiskCount: 0,
  };
  if (sample.state !== 'measured') return row;

  const onDiskByUrl = onDiskByUrlFor(show.id);
  row.onDiskCount = onDiskByUrl.size;

  const showInfo = getShowInfo(show.id);
  const geo = censusGeoFor(show);
  const naiveQuery = buildNaiveCensusQuery(show);
  row.naiveQuery = naiveQuery;
  if (!naiveQuery) return row;

  const found = new Set();
  for (let page = 0; page < pages; page++) {
    let results = [];
    let ok = true;
    try { results = await serpQuery(naiveQuery, { dateRange: null, preferSpeed: false, page, geo }) || []; }
    catch { results = []; ok = false; }
    row.queries.push({ ok, raw: results.length });
    for (const sr of results) {
      const accepted = acceptSerpCensusResult(sr, { show, showInfo });
      if (accepted) found.add(accepted);
    }
  }

  const guards = { isIncludableForRebuild, explainExclusion };
  row.candidates = [...found].map(url => classifyCandidate(url, show, onDiskByUrl, guards));
  return row;
}

async function main() {
  if (hasHelpFlag(args)) { console.log(USAGE); return 0; }

  for (const flag of ['ADVERSARIAL_PROBE_DISABLED', 'SERP_GAP_CENSUS_DISABLED']) {
    if (process.env[flag] === '1' || process.env[flag] === 'true') {
      console.log(`${flag} is set — skipping (no SERP calls spent).`);
      return 0;
    }
  }

  // Without this the SERP chain runs keyless: every candidate reads as a
  // real gap (nothing found ⇒ nothing to classify ⇒ trivially 'clean'), which
  // would be worse than not probing at all (same lesson as census-recall.js).
  loadEnv(ROOT);

  const shows = loadShows();
  const sampleSize = parseInt(getArg('sample', String(DEFAULT_SAMPLE)), 10);
  const days = parseInt(getArg('days', String(DEFAULT_DAYS)), 10);
  const pages = parseInt(getArg('pages', String(DEFAULT_PAGES)), 10);
  const settlingHours = parseInt(getArg('settling-hours', '24'), 10);
  const seedRaw = getArg('seed');
  const outPath = getArg('out') || OUT_PATH;
  const now = Date.now();

  const sample = pickSample(shows, {
    showIds: getArg('shows'),
    days, sample: sampleSize,
    seed: seedRaw !== null ? Number(seedRaw) : undefined,
    now,
  });

  if (!sample.length) {
    console.error('No shows matched the sample window — nothing to probe this run.');
    // Not a hard failure: an empty pool (e.g. a dead week for new openings)
    // is real information, not an error. Still write a report AND (under
    // --trend) a trend entry — the trend ledger must not silently skip a
    // week, else a --trend cron run leaves the status file aging toward
    // false staleness instead of recording this week's true "nothing to
    // measure" (ship-check finding: the original code returned before ever
    // reaching the --trend block below).
    const generatedAt = new Date().toISOString();
    const summary = { verdict: 'inconclusive', measured: 0, gapCount: 0, gapShows: [], reason: 'no shows in the sample window' };
    const out = { generatedAt, sample: [], summary };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    if (hasFlag('trend')) recordTrendAndStatus({ generatedAt, sampleSize: 0, summary });
    return 0;
  }

  console.log(`Coverage adversarial probe — ${sample.length} show(s) (naive query, ${pages} page(s) each)`);
  console.log('');

  const rows = [];
  for (const show of sample) {
    const row = await probeOneShow(show, { pages, now, settlingHours });
    rows.push(row);
    const s = summarizeShow(row.candidates);
    const tag = row.sampleState !== 'measured' ? `[${row.sampleState}: ${row.sampleReason}]`
      : (s.pass ? 'PASS' : 'FAIL');
    console.log(`${row.showId} (${row.title}) — ${tag}`);
    if (row.sampleState === 'measured') {
      console.log(`  live ${s.live} | excluded ${s.excluded} | GAP ${s.gaps.length}`);
      for (const g of s.gaps) console.log(`    ✗ undiscovered: ${g.url}`);
    }
    console.log('');
  }

  const summary = summarizeRun(rows);
  console.log('── RUN VERDICT ──');
  console.log(`  ${summary.verdict.toUpperCase()} — ${summary.measured} show(s) measured, ${summary.gapCount} gap(s)${summary.gapShows.length ? ` (${summary.gapShows.join(', ')})` : ''}`);
  if (summary.reason) console.log(`  ${summary.reason}`);

  const out = { generatedAt: new Date().toISOString(), days, pages, sample: sample.map(s => s.id), shows: rows, summary };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);

  let exitCode = 0;
  if (hasFlag('trend')) {
    recordTrendAndStatus({ generatedAt: out.generatedAt, sampleSize: sample.length, summary });
  }

  if (summary.verdict === 'gaps-found' && hasFlag('fail-on-gap')) exitCode = 1;
  return exitCode;
}

/** Append this run's verdict to the trend ledger, judge the acceptance bar,
 * and write both output files. Shared by the normal path AND the empty-pool
 * early-return (ship-check finding: the original code only reached this
 * block via the full sample path, so an empty-pool week under --trend left
 * the trend ledger silently missing that week and the status file aging
 * toward false staleness instead of recording "nothing to measure"). */
function recordTrendAndStatus({ generatedAt, sampleSize, summary }) {
  const entry = {
    date: generatedAt.slice(0, 10),
    generatedAt,
    sampleSize,
    verdict: summary.verdict,
    measured: summary.measured,
    gapCount: summary.gapCount,
    gapShows: summary.gapShows,
    reason: summary.reason || null,
  };
  const entries = appendTrendEntry(TREND_PATH, entry);
  const acceptance = evaluateAcceptance(entries);
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, JSON.stringify({
    generatedAt,
    verdict: summary.verdict,
    gapCount: summary.gapCount,
    gapShows: summary.gapShows,
    trendEntries: entries.length,
    acceptance,
    latest: entry,
  }, null, 2) + '\n');
  console.log(`\n── ACCEPTANCE (2 consecutive clean weeks) ──`);
  console.log(`  ${acceptance.accepted ? 'ACCEPTED' : 'not yet'} — ${acceptance.reason}`);
  console.log(`  ledger: ${path.relative(ROOT, TREND_PATH)}`);
  console.log(`  status: ${path.relative(ROOT, STATUS_PATH)}`);
  return { entry, entries, acceptance };
}

function readTrendEntries(trendPath) {
  try {
    return String(fs.readFileSync(trendPath, 'utf8')).split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Same-date replacement, temp-file+rename write — mirrors
 * audit-serp-census-recall.js's appendTrendEntry, INCLUDING its "don't
 * downgrade a same-day record" guard (Codex ship-check finding: the first
 * version of this function replaced unconditionally, so a stronger earlier
 * measurement that day — e.g. the real weekly cron — could be silently
 * overwritten by a thinner manual poke run later the same day). A
 * replacement is accepted only when it measured at least as many shows;
 * cross-push races on this file are additionally handled by the
 * reconcile-merged-json.js registration (mergeCoverageAdversarialProbeTrend),
 * which this same "more evidence wins" rule mirrors.
 */
function appendTrendEntry(trendPath, entry, opts = {}) {
  const existing = readTrendEntries(trendPath);
  const weaker = entry.date
    ? existing.find(e => e.date === entry.date && (e.measured || 0) > (entry.measured || 0))
    : null;
  if (weaker && !opts.force) {
    console.log(`  (kept the existing ${entry.date} entry — it measured ${weaker.measured} show(s) vs this run's ${entry.measured || 0})`);
    return existing;
  }
  const kept = entry.date ? existing.filter(e => e.date !== entry.date) : existing;
  const all = [...kept, entry].slice(-TREND_MAX_ENTRIES);
  fs.mkdirSync(path.dirname(trendPath), { recursive: true });
  const tmp = `${trendPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, all.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(tmp, trendPath);
  return all;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { pickSample, onDiskByUrlFor, probeOneShow, appendTrendEntry, readTrendEntries, recordTrendAndStatus, USAGE };
