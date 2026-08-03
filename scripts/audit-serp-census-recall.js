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
 * Usage:
 *   node scripts/audit-serp-census-recall.js                      # 20 most recently opened shows
 *   node scripts/audit-serp-census-recall.js --limit=8
 *   node scripts/audit-serp-census-recall.js --shows=id1,id2
 *   node scripts/audit-serp-census-recall.js --pages=3 --days=45
 *   node scripts/audit-serp-census-recall.js --scoped-only        # skip the naive arm
 *
 * Cost: (scoped arms 1-3) + (naive pages, default 3) SERP calls per show, all
 * through the shared BD/SD/SB chain in lib/url-discovery.js (24h disk cache,
 * so a re-run inside the TTL is nearly free). At the default --limit=20 that
 * is ~100-120 calls — run it deliberately, not on a cron.
 *
 * Output: data/audit/serp-census-recall.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { serpQuery, calculateDateWindow, getShowInfo } = require('./lib/url-discovery');
const { buildCensusQueries, buildCensusPlan, buildNaiveCensusQuery, censusGeoFor, DEFAULT_NAIVE_PAGES } = require('./lib/serp-review-census');
const { acceptSerpCensusResult, normalizeReviewUrl, isReviewUrl } = require('./audit-show-review-gap.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const OUT_PATH = path.join(ROOT, 'data', 'audit', 'serp-census-recall.json');

const USAGE = `Usage: node scripts/audit-serp-census-recall.js [options]

Measures SERP census recall against a naive Google search (task #872).

Options:
  --shows=a,b,c    Audit these show IDs instead of the recent-openings pool
  --limit=N        Max shows from the pool (default 20)
  --days=N         Pool = shows that opened within the last N days (default 30)
  --pages=N        Naive-arm pages to read (default ${DEFAULT_NAIVE_PAGES})
  --scoped-only    Run only the pre-#872 scoped arms (no naive arm)
  --out=PATH       Override output path (default data/audit/serp-census-recall.json)
  --help, -h       Show this message

Writes a per-show recall report to ${path.relative(ROOT, OUT_PATH)}.`;

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

function pickShows(shows) {
  const explicit = getArg('shows');
  if (explicit) {
    const ids = explicit.split(',').map(s => s.trim()).filter(Boolean);
    return ids.map(id => shows.find(s => s.id === id)).filter(Boolean);
  }
  const days = parseInt(getArg('days', '30'), 10);
  const limit = parseInt(getArg('limit', '20'), 10);
  const cutoff = Date.now() - days * 86400000;
  return shows
    .filter(s => s.openingDate && Date.parse(s.openingDate) >= cutoff && Date.parse(s.openingDate) <= Date.now())
    .sort((a, b) => (a.openingDate < b.openingDate ? 1 : -1))
    .slice(0, limit);
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

  const shows = loadShows();
  const pool = pickShows(shows);
  if (!pool.length) {
    console.error('No shows matched the selection — nothing to measure.');
    return 1;
  }
  const naivePages = hasFlag('scoped-only') ? 0 : parseInt(getArg('pages', String(DEFAULT_NAIVE_PAGES)), 10);
  const outPath = getArg('out') || OUT_PATH;

  console.log(`SERP census recall harness — ${pool.length} show(s), naive pages: ${naivePages}\n`);

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
    for (const query of buildCensusQueries(show, { creativeNames })) {
      const r = await runArm(show, showInfo, { query, dateRange, page: 0, geo: undefined });
      for (const u of r.urls) scopedUrls.add(u);
      armDetail.push({ arm: 'scoped', query, page: 0, geo: null, raw: r.raw, accepted: r.urls.size, ok: r.ok, error: r.error });
    }

    // The owner's query, read N pages deep.
    const naiveUrls = new Set();
    const naiveQuery = buildNaiveCensusQuery(show);
    for (let page = 0; page < naivePages && naiveQuery; page++) {
      const r = await runArm(show, showInfo, { query: naiveQuery, dateRange: null, page, geo });
      for (const u of r.urls) naiveUrls.add(u);
      armDetail.push({ arm: `naive-p${page}`, query: naiveQuery, page, geo, raw: r.raw, accepted: r.urls.size, ok: r.ok, error: r.error });
    }

    const disk = onDiskUrls(show.id);
    const truth = new Set([...scopedUrls, ...naiveUrls, ...disk]);
    const inTruth = (set) => [...set].filter(u => truth.has(u)).length;
    const newFromNaive = [...naiveUrls].filter(u => !scopedUrls.has(u) && !disk.has(u));

    const row = {
      showId: show.id,
      title: show.title,
      market: show.category || show.market || null,
      openingDate: show.openingDate || null,
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

    console.log(`${show.id} (${show.title})`);
    console.log(`  truth ${row.counts.truth} | scoped ${row.counts.scoped} (recall ${row.recall.scoped}) | naive ${row.counts.naive} (recall ${row.recall.naive}) | onDisk ${row.counts.onDisk}`);
    if (newFromNaive.length) {
      console.log(`  + ${newFromNaive.length} URL(s) ONLY the naive arm found:`);
      newFromNaive.forEach(u => console.log(`      ${u}`));
    }
    console.log('');
  }

  const sum = (f) => report.reduce((a, r) => a + f(r), 0);
  const totals = {
    shows: report.length,
    truthUrls: sum(r => r.counts.truth),
    scopedUrls: sum(r => r.counts.scoped),
    naiveUrls: sum(r => r.counts.naive),
    onDiskUrls: sum(r => r.counts.onDisk),
    newFromNaive: sum(r => r.newFromNaive.length),
  };
  totals.scopedRecall = pct(totals.scopedUrls, totals.truthUrls);
  totals.naiveRecall = pct(totals.naiveUrls, totals.truthUrls);

  const out = { generatedAt: new Date().toISOString(), naivePages, totals, shows: report };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  console.log('── TOTALS ──');
  console.log(`  ground-truth URLs: ${totals.truthUrls}`);
  console.log(`  scoped arms:       ${totals.scopedUrls} (recall ${totals.scopedRecall})`);
  console.log(`  naive arm:         ${totals.naiveUrls} (recall ${totals.naiveRecall})`);
  console.log(`  naive-only URLs:   ${totals.newFromNaive}`);
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { onDiskUrls, pickShows, USAGE };
