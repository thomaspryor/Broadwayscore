#!/usr/bin/env node
/**
 * audit-serp-census-recall.js — measure the SERP review census against the
 * search a human actually runs.
 *
 * Why (owner escalation 2026-08-02, task #872): "A quick Google for every new
 * show that opens shows the issues. This is why I cannot trust efforts here."
 * Four consecutive spot-checks (The Car Man, Brainiac Live, Tao of Glass,
 * Rosie O'Donnell: Common Knowledge) each turned up published reviews the
 * census had reported as absent. Tasks #371/#444/#720/#767 all improved
 * individual arms without anyone ever measuring the whole thing against the
 * naive baseline, so recall regressions were invisible by construction.
 *
 * What it does, per show:
 *   scoped   — the phrase-quoted, year-clamped, date-windowed arms
 *              (buildCensusQueries), page 1 only. This is what the census was
 *              before #872.
 *   naive    — "<title> <venue> review", no quotes, no date window, market-
 *              derived geo, read N pages deep. This is what the owner types.
 *   onDisk   — review URLs already collected for the show (the pipeline's
 *              current answer).
 * Ground truth is the union of all three, and each arm's recall is measured
 * against it. `newFromNaive` — URLs only the naive arm saw — is the list that
 * matters: every entry is a review a human would find and the old census
 * would not.
 *
 * ── Cadence (task #898, Coverage Verdict S1) ───────────────────────────────
 * #872 shipped this as a ONE-SHOT. A single measurement cannot see a
 * regression — a regression is a change, and one number has nothing to change
 * from — which is the same blindness that let #371/#444/#720/#767 each improve
 * an arm without anyone noticing what the whole had done. So:
 *   --sample=N   picks a small recent-openings sample sized for a cron
 *   --trend      appends the run's per-arm recall to
 *                data/audit/census-recall-trend.jsonl and judges the latest
 *                run against each arm's own recent median
 *                (scripts/lib/census-recall.js)
 * The judgement lands in data/audit/census-recall-status.json, which
 * health-check.js surfaces as the daily-digest check "Coverage: SERP census
 * recall". A regression NEVER fails this run (exit stays 0 unless
 * --fail-on-regression): a red run for as long as an arm stays broken would
 * make check-cron-health flag this detector as stale and redispatch it in a
 * loop — the same trap check-arm-yield.yml documents.
 *
 * Kill switch: CENSUS_RECALL_DISABLED=1 exits 0 without spending a SERP call.
 *
 * Usage:
 *   node scripts/audit-serp-census-recall.js                      # 20 most recently opened shows
 *   node scripts/audit-serp-census-recall.js --sample=10          # alias for --limit
 *   node scripts/audit-serp-census-recall.js --shows=id1,id2
 *   node scripts/audit-serp-census-recall.js --pages=3 --days=45
 *   node scripts/audit-serp-census-recall.js --scoped-only        # skip the naive arm
 *   node scripts/audit-serp-census-recall.js --sample=5 --trend   # the cron shape
 *
 * Cost: (scoped arms 1-3) + (naive pages, default 3) SERP calls per show, all
 * through the shared BD/SD/SB chain in lib/url-discovery.js (24h disk cache,
 * so a re-run inside the TTL is nearly free). At the default --limit=20 that
 * is ~100-120 calls; the weekly cron's --sample=5 --pages=2 is ~25.
 *
 * Output: data/audit/serp-census-recall.json,
 *         data/audit/census-recall-trend.jsonl (--trend),
 *         data/audit/census-recall-status.json (--trend)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { serpQuery, calculateDateWindow, getShowInfo } = require('./lib/url-discovery');
const { buildCensusQueries, buildCensusPlan, buildNaiveCensusQuery, censusGeoFor, DEFAULT_NAIVE_PAGES } = require('./lib/serp-review-census');
const { acceptSerpCensusResult, normalizeReviewUrl, isReviewUrl } = require('./audit-show-review-gap.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { loadEnv } = require('./lib/load-env.js');
const {
  classifySample, detectProviderOutage, detectRecallRegression, parseTrendJsonl,
  perArmRecall, perCategoryRecall, summarizeRun,
} = require('./lib/census-recall.js');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const OUT_PATH = path.join(AUDIT_DIR, 'serp-census-recall.json');
const TREND_PATH = path.join(AUDIT_DIR, 'census-recall-trend.jsonl');
const STATUS_PATH = path.join(AUDIT_DIR, 'census-recall-status.json');

/** Undated shows pulled in per run under --include-undated (they have no window to scope on). */
const UNDATED_SAMPLE_CAP = 3;

const USAGE = `Usage: node scripts/audit-serp-census-recall.js [options]

Measures SERP census recall against a naive Google search (tasks #872/#898).

Options:
  --shows=a,b,c        Audit these show IDs instead of the recent-openings pool
  --limit=N            Max shows from the pool (default 20)
  --sample=N           Alias for --limit (the cadence's vocabulary)
  --days=N             Pool = shows that opened within the last N days (default 30)
  --pages=N            Naive-arm pages to read (default ${DEFAULT_NAIVE_PAGES})
  --scoped-only        Run only the pre-#872 scoped arms (no naive arm)
  --include-undated    Also sample up to ${UNDATED_SAMPLE_CAP} open shows with no openingDate
                       (377 exist; always counted, never silently dropped)
  --settling-hours=N   Shows opened within N hours are 'settling' and excluded
                       from the headline recall (default 24 — SERP indexing lag)
  --trend              Append this run to the trend ledger and judge it against
                       each arm's own recent median
  --fail-on-regression Exit 1 when the trend judgement is 'regressed'
                       (off by default — see the header)
  --out=PATH           Override report path (default data/audit/serp-census-recall.json)
  --trend-out=PATH     Override trend ledger path
  --help, -h           Show this message

Writes a per-show recall report to ${path.relative(ROOT, OUT_PATH)}.
Kill switch: CENSUS_RECALL_DISABLED=1.`;

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

/** Normalized review URLs already on disk for a show. */
function onDiskUrls(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  const out = new Set();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const u = rec && rec.url;
    if (u && isReviewUrl(u)) out.add(normalizeReviewUrl(u));
  }
  return out;
}

/**
 * Choose the sample.
 *
 * Undated shows are the reason this returns a shape rather than an array. The
 * #872 cut filtered on `s.openingDate && …`, so the 377 shows with no
 * openingDate were dropped at selection time and never appeared anywhere in
 * the output — an invisible hole in a harness whose entire job is finding
 * invisible holes. They are now COUNTED always, and sampled under
 * --include-undated (where they land in the report as `unknown-date` rows,
 * outside the headline recall because there is no window to judge them in).
 *
 * @returns {{pool:Array<object>, undatedCandidates:number, undatedIncluded:number, explicit:boolean}}
 */
function pickShows(shows, opts = {}) {
  const explicit = opts.showIds || getArg('shows');
  if (explicit) {
    const ids = String(explicit).split(',').map(s => s.trim()).filter(Boolean);
    return {
      pool: ids.map(id => shows.find(s => s.id === id)).filter(Boolean),
      undatedCandidates: 0,
      undatedIncluded: 0,
      explicit: true,
    };
  }
  const days = opts.days === undefined ? parseInt(getArg('days', '30'), 10) : opts.days;
  const limit = opts.limit === undefined
    ? parseInt(getArg('sample') || getArg('limit', '20'), 10)
    : opts.limit;
  const includeUndated = opts.includeUndated === undefined ? hasFlag('include-undated') : opts.includeUndated;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const cutoff = now - days * 86400000;

  const pool = shows
    .filter(s => s.openingDate && Date.parse(s.openingDate) >= cutoff && Date.parse(s.openingDate) <= now)
    .sort((a, b) => (a.openingDate < b.openingDate ? 1 : -1))
    .slice(0, limit);

  // Undated candidates: open shows the pipeline is actively collecting for but
  // whose recall no date-windowed selection can ever measure.
  const undated = shows.filter(s => !s.openingDate && s.status === 'open' && s.title);
  const undatedIncluded = includeUndated ? undated.slice(0, UNDATED_SAMPLE_CAP) : [];

  return {
    pool: [...pool, ...undatedIncluded],
    undatedCandidates: undated.length,
    undatedIncluded: undatedIncluded.length,
    explicit: false,
  };
}

/** Run one arm; returns {urls:Set, raw:number, ok:boolean, error:string|null}. */
async function runArm(show, showInfo, { query, dateRange, page, geo }) {
  const urls = new Set();
  try {
    const results = await serpQuery(query, { dateRange, preferSpeed: false, page, geo }) || [];
    for (const sr of results) {
      const accepted = acceptSerpCensusResult(sr, { show, showInfo });
      if (accepted) urls.add(accepted);
    }
    return { urls, raw: results.length, ok: true, error: null };
  } catch (e) {
    return { urls, raw: 0, ok: false, error: (e.message || '').slice(0, 160) };
  }
}

const pct = (n, d) => (d === 0 ? 1 : Math.round((n / d) * 1000) / 1000);

async function main() {
  if (hasHelpFlag(args)) { console.log(USAGE); return 0; }

  if (process.env.CENSUS_RECALL_DISABLED === '1' || process.env.CENSUS_RECALL_DISABLED === 'true') {
    console.log('CENSUS_RECALL_DISABLED is set — skipping (no SERP calls spent).');
    return 0;
  }

  // Without this the SERP chain runs keyless: every arm returns [] with a
  // warning on stderr and the run records a flat 0.0 recall it would then feed
  // to the trend as evidence of a regression. (Reproduced 2026-08-02 on the
  // first cadence smoke run — the provider-outage guard below is the second
  // half of that fix, for the case where the keys exist but the chain is down.)
  loadEnv(ROOT);

  const shows = loadShows();
  const selection = pickShows(shows);
  const pool = selection.pool;
  if (!pool.length) {
    console.error('No shows matched the selection — nothing to measure.');
    return 1;
  }
  const naivePages = hasFlag('scoped-only') ? 0 : parseInt(getArg('pages', String(DEFAULT_NAIVE_PAGES)), 10);
  const settlingHours = parseInt(getArg('settling-hours', '24'), 10);
  const outPath = getArg('out') || OUT_PATH;
  const now = Date.now();

  console.log(`SERP census recall harness — ${pool.length} show(s), naive pages: ${naivePages}`);
  if (!selection.explicit) {
    console.log(`  undated shows (no openingDate, open): ${selection.undatedCandidates} candidate(s), ${selection.undatedIncluded} sampled${selection.undatedIncluded ? '' : ' (use --include-undated)'}`);
  }
  console.log('');

  const report = [];
  for (const show of pool) {
    const showInfo = getShowInfo(show.id);
    const dateRange = calculateDateWindow(show);
    const geo = censusGeoFor(show);
    const creativeNames = showInfo.creativeNames || [];

    // Pre-#872 behavior: quoted arms, date-windowed, page 1, geo left to
    // url-discovery's "does the query contain 'West End'" heuristic.
    const scopedUrls = new Set();
    const armDetail = [];
    const scopedQueries = buildCensusQueries(show, { creativeNames });
    for (let qi = 0; qi < scopedQueries.length; qi++) {
      const query = scopedQueries[qi];
      const r = await runArm(show, showInfo, { query, dateRange, page: 0, geo: undefined });
      for (const u of r.urls) scopedUrls.add(u);
      // Labelled per QUERY SLOT (q0 = primary, q1 = venue-scoped, q2 =
      // people-scoped), not lumped as 'scoped'. The failure this cadence has to
      // catch is one arm dying while its siblings cover for it — a single
      // 'scoped' number cannot show that, and the run-level recall barely moves.
      armDetail.push({
        arm: `scoped-q${qi}`, query, page: 0, geo: null,
        raw: r.raw, accepted: r.urls.size, urls: [...r.urls], ok: r.ok, error: r.error,
      });
    }

    // The owner's query, read N pages deep.
    const naiveUrls = new Set();
    const naiveQuery = buildNaiveCensusQuery(show);
    for (let page = 0; page < naivePages && naiveQuery; page++) {
      const r = await runArm(show, showInfo, { query: naiveQuery, dateRange: null, page, geo });
      for (const u of r.urls) naiveUrls.add(u);
      armDetail.push({
        arm: `naive-p${page}`, query: naiveQuery, page, geo,
        raw: r.raw, accepted: r.urls.size, urls: [...r.urls], ok: r.ok, error: r.error,
      });
    }

    const disk = onDiskUrls(show.id);
    // What the pipeline currently holds is itself an arm — the one whose trend
    // the owner actually feels — so it is recorded in the same shape as the
    // SERP arms and rides the same per-arm recall + regression machinery.
    armDetail.push({
      arm: 'onDisk', query: null, page: null, geo: null,
      raw: disk.size, accepted: disk.size, urls: [...disk], ok: true, error: null,
    });

    const truth = new Set([...scopedUrls, ...naiveUrls, ...disk]);
    const inTruth = (set) => [...set].filter(u => truth.has(u)).length;
    const newFromNaive = [...naiveUrls].filter(u => !scopedUrls.has(u) && !disk.has(u));
    const sample = classifySample(show, { now, settlingHours });

    const row = {
      showId: show.id,
      title: show.title,
      market: show.category || show.market || null,
      openingDate: show.openingDate || null,
      sampleState: sample.state,
      sampleReason: sample.reason,
      geo,
      naiveQuery,
      counts: {
        truth: truth.size,
        scoped: scopedUrls.size,
        naive: naiveUrls.size,
        onDisk: disk.size,
      },
      recall: {
        scoped: pct(inTruth(scopedUrls), truth.size),
        naive: pct(inTruth(naiveUrls), truth.size),
        onDisk: pct(inTruth(disk), truth.size),
        // The headline number: what the census (scoped arms) plus what we
        // already hold still miss, relative to everything findable.
        censusPlusDisk: pct(new Set([...scopedUrls, ...disk]).size, truth.size),
      },
      newFromNaive,
      missedByCensus: [...truth].filter(u => !scopedUrls.has(u)),
      arms: armDetail,
    };
    report.push(row);

    console.log(`${show.id} (${show.title})${sample.state === 'measured' ? '' : `  [${sample.state}: ${sample.reason}]`}`);
    console.log(`  truth ${row.counts.truth} | scoped ${row.counts.scoped} (recall ${row.recall.scoped}) | naive ${row.counts.naive} (recall ${row.recall.naive}) | onDisk ${row.counts.onDisk}`);
    if (newFromNaive.length) {
      console.log(`  + ${newFromNaive.length} URL(s) ONLY the naive arm found:`);
      newFromNaive.forEach(u => console.log(`      ${u}`));
    }
    console.log('');
  }

  // Only `measured` rows carry the headline. A show still settling has reviews
  // missing from Google's INDEX, not from the census, and an undated show has
  // no window any arm could have been scoped to — counting either manufactures
  // a recall dip on exactly the days the pipeline is busiest.
  const measured = report.filter(r => r.sampleState === 'measured');
  const excludedRows = report.filter(r => r.sampleState !== 'measured');
  const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
  const agg = perArmRecall(measured);
  const totals = {
    shows: measured.length,
    excluded: excludedRows.map(r => ({ showId: r.showId, state: r.sampleState, reason: r.sampleReason })),
    undatedCandidates: selection.undatedCandidates,
    truthUrls: agg.truthUrls,
    scopedUrls: sum(measured, r => r.counts.scoped),
    naiveUrls: sum(measured, r => r.counts.naive),
    onDiskUrls: sum(measured, r => r.counts.onDisk),
    newFromNaive: sum(measured, r => r.newFromNaive.length),
    perArm: agg.arms,
    perFamily: agg.families,
    byCategory: perCategoryRecall(measured),
  };
  totals.scopedRecall = pct(totals.scopedUrls, totals.truthUrls);
  totals.naiveRecall = pct(totals.naiveUrls, totals.truthUrls);

  const out = { generatedAt: new Date().toISOString(), naivePages, settlingHours, totals, shows: report };

  console.log('── TOTALS (measured shows only) ──');
  console.log(`  measured shows:    ${totals.shows}${excludedRows.length ? ` (${excludedRows.length} excluded: ${excludedRows.map(r => r.sampleState).join(', ')})` : ''}`);
  console.log(`  ground-truth URLs: ${totals.truthUrls}`);
  console.log(`  naive-only URLs:   ${totals.newFromNaive}`);
  console.log('\n── PER-ARM RECALL ──');
  for (const [arm, v] of Object.entries(totals.perArm)) {
    console.log(`  ${arm.padEnd(12)} recall ${fmtRecall(v.recall)}  (${v.found}/${totals.truthUrls} URLs over ${v.queries} query-run(s)${v.failed ? `, ${v.failed} FAILED` : ''})`);
  }
  console.log('  ── by family ──');
  for (const [fam, v] of Object.entries(totals.perFamily)) {
    console.log(`  ${fam.padEnd(12)} recall ${fmtRecall(v.recall)}  (${v.found}/${totals.truthUrls} URLs, ${v.arms} arm(s))`);
  }
  for (const [cat, v] of Object.entries(totals.byCategory)) {
    const parts = Object.entries(v.families).map(([f, d]) => `${f} ${fmtRecall(d.recall)}`).join(' | ');
    console.log(`  ${String(cat).padEnd(14)} ${v.shows} show(s), ${v.truthUrls} truth URLs — ${parts}`);
  }

  // Provider-outage guard. A missing key, an exhausted ScrapingBee cap or a
  // dead Bright Data zone makes every SERP arm return nothing — which is
  // indistinguishable, in the numbers, from every arm having regressed to zero
  // recall. Recording that as a data point would put a fabricated collapse into
  // the median every future run is judged against. If NO SERP query-run in the
  // whole run saw a single raw result, the chain is down: report it, write no
  // trend entry. (Reproduced 2026-08-02: a keyless run wrote scoped 0.0 / naive
  // 0.0 to the ledger before this guard existed.)
  const outage = detectProviderOutage(report);
  const providerOutage = outage.outage;
  out.providerOutage = providerOutage;
  if (providerOutage) {
    console.log(`\n⚠ PROVIDER OUTAGE: all ${outage.serpRuns} SERP query-run(s) returned zero raw results — the scraping chain is down, not the census.`);
  }

  let exitCode = 0;
  if (hasFlag('trend')) {
    const trendPath = getArg('trend-out') || TREND_PATH;
    const entry = summarizeRun(out);
    const entries = providerOutage
      ? readTrendEntries(trendPath)
      : appendTrendEntry(trendPath, entry);
    const judgement = providerOutage
      ? {
        verdict: 'blind',
        reason: `every SERP arm returned zero raw results (${serpRuns.length} query-run(s)) — provider outage, run NOT recorded to the trend`,
        regressions: [], latest: null, comparedArms: 0,
      }
      : detectRecallRegression(entries);
    out.trend = { entry, judgement };
    if (providerOutage) console.log('  (trend entry NOT written — outage runs must not enter the baseline)');

    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify({
      generatedAt: out.generatedAt,
      verdict: judgement.verdict,
      reason: judgement.reason,
      regressions: judgement.regressions,
      comparedArms: judgement.comparedArms,
      trendEntries: entries.length,
      latest: entry,
    }, null, 2) + '\n');

    console.log(`\n── TREND (${entries.length} run(s) on record) ──`);
    console.log(`  verdict: ${judgement.verdict.toUpperCase()} — ${judgement.reason}`);
    console.log(`  ledger:  ${path.relative(ROOT, trendPath)}`);
    console.log(`  status:  ${path.relative(ROOT, STATUS_PATH)}`);
    if (judgement.verdict === 'regressed' && hasFlag('fail-on-regression')) exitCode = 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  return exitCode;
}

const fmtRecall = (r) => (r === null || r === undefined ? '  n/a' : r.toFixed(3));

/**
 * Append `entry` to the JSONL trend ledger and return every entry in order.
 *
 * Same-date entries are REPLACED, not appended: a re-run (a manual dispatch
 * after a provider outage, a backfill) must correct that day's number rather
 * than double-weight it in the median the regression detector reads.
 */
function readTrendEntries(trendPath) {
  try { return parseTrendJsonl(fs.readFileSync(trendPath, 'utf8')); } catch { return []; }
}

function appendTrendEntry(trendPath, entry) {
  const existing = readTrendEntries(trendPath);
  const kept = entry.date ? existing.filter(e => e.date !== entry.date) : existing;
  const all = [...kept, entry];
  fs.mkdirSync(path.dirname(trendPath), { recursive: true });
  fs.writeFileSync(trendPath, all.map(e => JSON.stringify(e)).join('\n') + '\n');
  return all;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { appendTrendEntry, onDiskUrls, pickShows, USAGE };
