#!/usr/bin/env node
'use strict';

/**
 * backfill-live-roundup-census.js — B5 of the v2 reconciler Sprint B plan.
 *
 * "90-day LIVE-refetch backfill audit → drains the current missing-review backlog
 *  and is the acceptance test for A+B."
 *
 * The plan's point 7 is explicit that this must NOT read data/aggregator-archive:
 * the archive only holds pages the OLD pipeline selected, so it structurally
 * cannot contain the failure class being tested. So every roundup here is fetched
 * LIVE, through two paths:
 *
 *   relive      — we HAVE an archived roundup; re-fetch the SAME canonical URL now.
 *                 Catches the page-level blind spot: roundups keep gaining review
 *                 links for days after publication, and our archive is a snapshot.
 *   rediscover  — we have NO archive for a source; find the roundup URL live
 *                 (bww-rr-discover / playbill-verdict search) and fetch it.
 *                 Catches the show-level blind spot (Broad Strokes: never polled,
 *                 so never archived, so permanently `no-census-yet`).
 *                 OFF by default (--rediscover) because BWW discovery can reach
 *                 Browserbase at ~$0.10/session.
 *
 * Freshly-fetched HTML is written to a THROWAWAY archive tree and the census is
 * built from there via buildCensusFromArchives. That is deliberate reuse, not a
 * shortcut: it runs the exact same extractors + cross-show page validation the
 * production census uses, so a difference in the result is a difference in the
 * BYTES, not in the parsing. The temp tree is never data/aggregator-archive —
 * this audit must not mutate the real archive.
 *
 * Decision logic is in lib/live-refetch-backfill.js (pure, unit-tested).
 *
 * SAFETY: read-only w.r.t. every core data file. It writes exactly two things —
 * a report and a checkpoint, both under data/audit/. It never ingests reviews;
 * the output is a work list you feed to gather-reviews.
 *
 * Usage:
 *   node scripts/backfill-live-roundup-census.js --days=90 --time-budget-min=25
 *   node scripts/backfill-live-roundup-census.js --days=90 --rediscover        # + live URL discovery
 *   node scripts/backfill-live-roundup-census.js --show=ID --dry-run           # plan only, zero fetches
 *   node scripts/backfill-live-roundup-census.js --resume                      # continue a budget-stopped run
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { buildCensusFromArchives, sourceExtractors } = require('./lib/review-census');
const { isDispatchTierOutlet } = require('./lib/t1-ledger');
const { isLondonMarket } = require('./lib/venue-classification');
const {
  selectBackfillWindow, diffLiveVsArchive, summarizeBackfill,
  emptyCheckpoint, isDone, recordDone, completedResults,
} = require('./lib/live-refetch-backfill');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REAL_ARCHIVE = path.join(DATA_DIR, 'aggregator-archive');
const REPORT_PATH = path.join(DATA_DIR, 'audit', 'live-refetch-backfill.json');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'audit', 'live-refetch-backfill-checkpoint.json');

const USAGE = `backfill-live-roundup-census.js — 90-day LIVE-refetch coverage backfill (B5).

Re-fetches roundups live (never reads the archive as truth) and reports, per show,
which expected reviews are drained vs still missing.

Usage:
  node scripts/backfill-live-roundup-census.js [options]

Options:
  --days=N              opening window (default 90)
  --show=ID             one show only
  --limit=N             stop after N shows (default 0 = no limit)
  --markets=a,b         restrict to shows.json categories (e.g. broadway,off-broadway)
  --rediscover          also discover roundup URLs live for sources with NO archive
                        (costs BWW/Playbill discovery; off by default)
  --time-budget-min=N   stop cleanly after N minutes and checkpoint (recommended)
  --resume              skip shows already recorded in the checkpoint
  --dry-run             print the plan; make ZERO network calls
  --report-path=P       default data/audit/live-refetch-backfill.json
  --checkpoint-path=P   default data/audit/live-refetch-backfill-checkpoint.json
  -h, --help            print this and exit
`;

function parseArgs(argv) {
  const o = {
    days: 90, showId: null, limit: 0, markets: null, rediscover: false,
    resume: false, dryRun: false, reportPath: REPORT_PATH, checkpointPath: CHECKPOINT_PATH,
  };
  for (const a of argv) {
    if (a.startsWith('--days=')) o.days = parseInt(a.split('=')[1], 10) || o.days;
    else if (a.startsWith('--show=')) o.showId = a.split('=')[1];
    else if (a.startsWith('--limit=')) o.limit = Math.max(0, parseInt(a.split('=')[1], 10) || 0);
    else if (a.startsWith('--markets=')) o.markets = a.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--rediscover') o.rediscover = true;
    else if (a === '--resume') o.resume = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--report-path=')) o.reportPath = a.split('=')[1];
    else if (a.startsWith('--checkpoint-path=')) o.checkpointPath = a.split('=')[1];
  }
  return o;
}

const loadJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function censusMarket(category) {
  if (isLondonMarket(category)) return 'west-end';
  if (category === 'off-broadway') return 'off-broadway';
  return 'broadway';
}

/**
 * The canonical URL an archived roundup came from, so we can re-fetch THAT page
 * rather than guess. Read out of the saved HTML itself (canonical/og:url), which
 * is the only record of provenance the archive keeps.
 */
function archivedSourceUrl(html) {
  const m = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html || '')
    || /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(html || '');
  return m ? m[1] : null;
}

/** Roundup sources for a market that we can actually re-fetch as plain HTML. */
function refetchableSources(market) {
  // westendtheatre archives are pre-extracted JSON from an API, not a page we can
  // re-fetch as HTML, and The Stage is cookie-gated — both are excluded so a run
  // never reports a fetch failure for something it was never going to fetch.
  const excluded = new Set(['westendtheatre', 'thestage']);
  return sourceExtractors(market).filter((s) => !excluded.has(s.name) && (s.ext || 'html') === 'html');
}

/** Live URL discovery for a source with no archive. Returns a URL or null. */
async function discoverSourceUrl(sourceName, show) {
  try {
    if (sourceName === 'bww-roundup') {
      const { discoverBwwRoundupUrl } = require('./lib/bww-rr-discover');
      const r = await discoverBwwRoundupUrl(show);
      return (r && r.url) || null;
    }
    if (sourceName === 'playbill-verdict') {
      const { searchPlaybillVerdict } = require('./lib/playbill-verdict-discover');
      const r = await searchPlaybillVerdict(show);
      return typeof r === 'string' ? r : (r && r.url) || null;
    }
  } catch (e) {
    console.log(`    ${sourceName}: discovery failed — ${e.message}`);
  }
  return null; // dtli / show-score have no cheap per-show URL discovery here
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const opts = parseArgs(process.argv.slice(2));
  const budget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

  const showsData = loadJSON(path.join(DATA_DIR, 'shows.json'));
  const shows = showsData.shows || showsData;
  const reviewsData = loadJSON(path.join(DATA_DIR, 'reviews.json'));
  const reviews = reviewsData.reviews || reviewsData;
  const registry = loadJSON(path.join(DATA_DIR, 'outlet-registry.json'));
  const outlets = registry.outlets || registry;

  let targets = opts.showId
    ? shows.filter((s) => (s.id || s.slug) === opts.showId)
    : selectBackfillWindow(shows, { days: opts.days, markets: opts.markets });
  if (!targets.length) { console.log('No shows in the backfill window.'); return; }

  let checkpoint = emptyCheckpoint();
  if (opts.resume) {
    try { checkpoint = loadJSON(opts.checkpointPath); } catch { checkpoint = emptyCheckpoint(); }
    const before = targets.length;
    targets = targets.filter((s) => !isDone(checkpoint, s.id || s.slug));
    console.log(`Resuming: ${before - targets.length} show(s) already done, ${targets.length} to go.`);
  }
  if (opts.limit) targets = targets.slice(0, opts.limit);

  const scoredByShow = new Map();
  for (const r of reviews) {
    if (!r || r.assignedScore == null || !r.outletId || !r.showId) continue;
    if (!scoredByShow.has(r.showId)) scoredByShow.set(r.showId, new Set());
    scoredByShow.get(r.showId).add(r.outletId);
  }

  console.log(`\n=== Live-Refetch Coverage Backfill (${opts.days}d window) ===`);
  console.log(`${targets.length} show(s)${opts.rediscover ? ' · live URL rediscovery ON' : ''}${opts.dryRun ? ' · DRY RUN (no fetches)' : ''}`);
  if (budget.enabled) console.log(`Time budget: ${budget.minutes} min\n`); else console.log('');

  if (opts.dryRun) {
    for (const s of targets.slice(0, 50)) {
      const showId = s.id || s.slug;
      const market = censusMarket(s.category || 'broadway');
      const srcs = refetchableSources(market);
      const withArchive = srcs.filter((src) => fs.existsSync(path.join(REAL_ARCHIVE, src.dir, `${showId}.html`)));
      console.log(`${showId} [${market}] opening=${s.openingDate || 'NULL'} — relive ${withArchive.length}/${srcs.length} source(s)`
        + `${opts.rediscover ? `, rediscover ${srcs.length - withArchive.length}` : ''}`);
    }
    if (targets.length > 50) console.log(`… ${targets.length - 50} more`);
    console.log(`\nDry run: 0 fetches made.`);
    return;
  }

  const { fetchPage } = require('./lib/scraper');
  // Throwaway tree — NEVER data/aggregator-archive. This audit must not mutate
  // the real archive (that file set is a separate private repo with its own
  // integrity gate), and a half-written live page there would corrupt the very
  // baseline the diff is measured against.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-refetch-'));
  let stoppedForBudget = false;
  const results = [];

  for (const show of targets) {
    const showId = show.id || show.slug;
    if (budget.exceeded()) { stoppedForBudget = true; break; }
    const market = censusMarket(show.category || 'broadway');
    const sources = refetchableSources(market);
    let fetched = 0;
    const fetchErrors = [];

    for (const src of sources) {
      if (budget.exceeded()) { stoppedForBudget = true; break; }
      const archivePath = path.join(REAL_ARCHIVE, src.dir, `${showId}.html`);
      let url = null;
      if (fs.existsSync(archivePath)) {
        url = archivedSourceUrl(fs.readFileSync(archivePath, 'utf8'));
      }
      // No archive, OR an archive that records no canonical URL (Playbill Verdict
      // pages routinely have neither canonical nor og:url, so ~all of them land
      // here) — both fall through to live discovery when it's enabled. Treating
      // "archived but unaddressable" as a hard skip made the relive path silently
      // useless for a whole source (observed on the first live probe).
      if (!url && opts.rediscover) url = await discoverSourceUrl(src.name, show);
      if (!url) {
        fetchErrors.push(fs.existsSync(archivePath)
          ? `${src.name}: archived page records no canonical URL${opts.rediscover ? ' and discovery found none' : ' (use --rediscover)'}`
          : `${src.name}: no archive${opts.rediscover ? ' and no URL discovered' : ' (use --rediscover)'}`);
        continue;
      }

      try {
        const res = await fetchPage(url);
        // fetchPage's contract is { content, format, source } across ALL tiers
        // (BD / ScrapingDog / ScrapingBee / Playwright) — `content`, not `html`.
        // Reading the wrong field made every successful fetch look like an empty
        // response, so the first live probe reported 0 fetches while Bright Data
        // logged 200 OK. .html/.body are kept only as defensive aliases.
        const html = typeof res === 'string' ? res : (res && (res.content || res.html || res.body));
        if (!html || html.length < 500) { fetchErrors.push(`${src.name}: empty/short response`); continue; }
        const outDir = path.join(tmpRoot, src.dir);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `${showId}.html`), html);
        fetched++;
      } catch (e) {
        fetchErrors.push(`${src.name}: ${e.message}`);
      }
    }

    // Census from the LIVE bytes vs census from the ARCHIVE bytes, same extractors.
    const liveCensus = safeCensus(showId, { show, market, archiveDir: tmpRoot });
    const archiveCensus = safeCensus(showId, { show, market, archiveDir: REAL_ARCHIVE });
    const diff = diffLiveVsArchive({
      liveOutletIds: liveCensus.entries.map((e) => e.outletId),
      archiveOutletIds: archiveCensus.entries.map((e) => e.outletId),
      scoredOutletIds: scoredByShow.get(showId) || new Set(),
      isTierOutlet: (id) => isDispatchTierOutlet(outlets, id),
    });

    const row = {
      showId, title: show.title, market, openingDate: show.openingDate || null,
      sourcesFetched: fetched, fetchErrors, ...diff,
    };
    results.push(row);
    checkpoint = recordDone(checkpoint, showId, row, new Date().toISOString());
    // Persist EVERY show, not every N: a SIGKILL at the workflow timeout must
    // never cost more than the show in flight (CLAUDE.md rule 8).
    try {
      fs.mkdirSync(path.dirname(opts.checkpointPath), { recursive: true });
      fs.writeFileSync(opts.checkpointPath, JSON.stringify(checkpoint, null, 2) + '\n');
    } catch (e) { console.error('checkpoint write failed:', e.message); }

    const flag = diff.newlyExpected.length ? ' 🆕' : '';
    console.log(`${showId}: fetched ${fetched}/${sources.length} · live census ${diff.liveCount} (archive ${diff.archiveCount})`
      + ` · drained ${diff.drained.length} · still missing ${diff.stillMissing.length}${flag}`);
    if (diff.newlyExpected.length) console.log(`   newly expected (archive could not see): ${diff.newlyExpected.join(', ')}`);
    for (const e of fetchErrors) console.log(`   ⚠ ${e}`);
  }

  // Summarize over the WHOLE checkpoint, not just this process's slice, so a
  // resumed run reports cumulative totals rather than the tail.
  const summary = summarizeBackfill(opts.resume ? completedResults(checkpoint) : results);
  console.log(`\n=== Summary ===`);
  console.log(`Shows processed:        ${summary.showsProcessed}`);
  console.log(`  with a live census:   ${summary.showsWithLiveCensus}`);
  console.log(`  NO live census:       ${summary.showsWithNoLiveCensus}  (not checked — never read as clean)`);
  console.log(`Expected reviews drained (live + scored):  ${summary.drained}`);
  console.log(`Expected reviews STILL MISSING:            ${summary.stillMissing}`);
  console.log(`Newly expected (invisible to the archive): ${summary.newlyExpected}`);
  console.log(`  shows the archive knew nothing about:    ${summary.showsInvisibleToArchive}`);
  console.log(`  shows whose roundup grew since archive:  ${summary.showsWithGrownRoundup}`);
  if (stoppedForBudget) {
    console.log(`\n⏱  Stopped on the ${budget.minutes}min budget after ${results.length} show(s). Resume with --resume.`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    daysChecked: opts.days, rediscover: opts.rediscover,
    stoppedForBudget, ...summary,
  };
  try {
    fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
    fs.writeFileSync(opts.reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport → ${opts.reportPath}`);
  } catch (e) { console.error('Failed to write report:', e.message); }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp dir */ }
}

function safeCensus(showId, opts) {
  try {
    const c = buildCensusFromArchives(showId, opts);
    return c && c.entries ? c : { entries: [] };
  } catch { return { entries: [] }; }
}

main().catch((err) => { console.error(err); process.exit(1); });
