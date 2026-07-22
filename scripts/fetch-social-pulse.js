#!/usr/bin/env node
/**
 * fetch-social-pulse.js — fetches social mentions + weekly buzz counters
 * for a single show (or all running shows), classifies the text sample
 * with GPT-4o-mini, scores it with the social-pulse-scorer library, and
 * writes two output files per show:
 *
 *   1. data/social-pulse/{show-id}.json       — canonical source
 *   2. public/data/shows/{show-id}.social.json — compact client-ready
 *
 * Writing to a SIBLING public file (not merging into the main show JSON)
 * eliminates the race with nightly generate-mobile-show-details.js rebuilds.
 *
 * SCHEMA v3 (2026-07, PR #431): the Apify actor stack is gone. Sources are
 * all free — Reddit + Bluesky text samples (sentiment/quotes) and uncapped
 * weekly COUNTERS (Reddit count, Bluesky hitsTotal, X tweet count while
 * the grandfathered token lives, Wikipedia article pageviews). `volume` is
 * now the TRUE weekly mention total, not a scrape-cap artifact; ranking
 * strength uses the relevance-adjusted effectiveVolume blend (see
 * SIGNAL_WEIGHTS in social-pulse-scorer.js).
 *
 * v2→v3 baseline reset: counters change the meaning of `volume`, so prior
 * v2 baselines/volumes are ignored (WoW% returns after the second v3 run).
 *
 * Usage:
 *   node scripts/fetch-social-pulse.js --show-id=maybe-happy-ending-2024
 *   node scripts/fetch-social-pulse.js --all-running
 *   node scripts/fetch-social-pulse.js --show-id=X --dry-run  (no writes)
 *
 * Required env:
 *   OPENAI_API_KEY                      (LLM relevance/sentiment classifier)
 * Strongly recommended in CI:
 *   BSKY_HANDLE + BSKY_APP_PASSWORD     (Bluesky auth — the public endpoint
 *                                        403s from datacenter IPs; without
 *                                        these the run aborts via the
 *                                        coverage guard, by design)
 *   SCRAPINGBEE_API_KEY                 (Reddit 403 fallback proxy)
 * Optional:
 *   X_BEARER_TOKEN                      (weekly tweet counts, at-risk)
 *
 * Fleet health guards (exit codes for the workflow):
 *   4 — >30% of shows have zero relevant sample mentions (classifier/sample
 *       pipeline broken)
 *   6 — counter coverage collapsed: >50% of shows missing the Bluesky
 *       counter, or >90% of shows with Reddit=0 (a platform is broken or
 *       secrets are missing — do NOT ship an index computed from the
 *       surviving signals; it would silently reweight every show)
 */

const fs = require('fs');
const path = require('path');

const { fetchAllPulseSources } = require('./lib/social-pulse-sources');
const { fetchWeeklyPageviews } = require('./lib/wikipedia-pageviews');
const { classifyMentions } = require('./lib/social-pulse-llm');
const { computeSocialPulse } = require('./lib/social-pulse-scorer');
const { listRunningShows } = require('./lib/list-running-shows');

const REPO_ROOT = path.join(__dirname, '..');
const SOCIAL_PULSE_DIR = path.join(REPO_ROOT, 'data', 'social-pulse');
const PUBLIC_SHOWS_DIR = path.join(REPO_ROOT, 'public', 'data', 'shows');
const META_FILE = path.join(SOCIAL_PULSE_DIR, '_meta.json');
const WIKI_MAP_FILE = path.join(REPO_ROOT, 'data', 'wikipedia-title-map.json');

// Text-sample sizes (Job B). These bound the LLM classification batch, NOT
// the volume metric — volume comes from the uncapped counters.
const REDDIT_MAX = 100;
const BLUESKY_MAX = 100;

// ---------- CLI argument parsing ----------

function parseArgs(argv) {
  const args = { showId: null, allRunning: false, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--show-id=')) args.showId = arg.slice('--show-id='.length);
    else if (arg === '--all-running') args.allRunning = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  if (!args.showId && !args.allRunning) {
    console.error('Usage: fetch-social-pulse.js --show-id=ID | --all-running [--dry-run]');
    process.exit(2);
  }
  return args;
}

// ---------- Filesystem helpers ----------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Run stamp. Replaces the Apify-era _budget.json — health-check.js reads
 * lastUpdated to catch a silently-dead Monday workflow (powers /trending).
 */
function writeRunMeta(stats) {
  ensureDir(SOCIAL_PULSE_DIR);
  const meta = {
    lastUpdated: new Date().toISOString(),
    schema: 3,
    ...stats,
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function loadWikiTitleMap() {
  if (!fs.existsSync(WIKI_MAP_FILE)) {
    console.warn('No data/wikipedia-title-map.json — Wikipedia counter disabled (run scripts/map-show-wikipedia-articles.js)');
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(WIKI_MAP_FILE, 'utf-8')).titles || {};
  } catch {
    return {};
  }
}

// ---------- Show lookup ----------

function loadShow(showId) {
  const showsPath = path.join(REPO_ROOT, 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
  if (!raw.shows) throw new Error('data/shows.json has unexpected shape');
  const show = raw.shows.find((s) => s.id === showId);
  if (!show) throw new Error(`Show not found: ${showId}`);
  return show;
}

function getMarketQualifier(show) {
  // Default to 'broadway' for null category — matches market-utils.ts behavior
  const cat = show.category || 'broadway';
  if (cat === 'west-end' || cat === 'off-west-end') return 'west end';
  return 'broadway';
}

function getMarketLabel(show) {
  const cat = show.category || 'broadway';
  if (cat === 'west-end') return 'West End';
  if (cat === 'off-west-end') return 'Off-West End';
  if (cat === 'off-broadway') return 'Off-Broadway';
  return 'Broadway';
}

// ---------- Prior data ----------

/**
 * Loads the prior canonical file for baseline/WoW continuity — but ONLY
 * from schema v3 onward. v2 volumes were capped-sample artifacts; carrying
 * their baselines across the semantics change would make every first-week
 * WoW/baseline comparison span the discontinuity.
 */
function loadPriorSocialPulse(showId) {
  const file = path.join(SOCIAL_PULSE_DIR, `${showId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const prior = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if ((prior._v || 1) < 3) return null; // v2→v3 baseline reset
    return prior;
  } catch {
    return null;
  }
}

// ---------- Output file writers ----------

function writeCanonicalFile(showId, data) {
  ensureDir(SOCIAL_PULSE_DIR);
  const file = path.join(SOCIAL_PULSE_DIR, `${showId}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Writes the compact client-ready sibling public file.
 *
 * Schema v3 keys:
 *   { _v: 3, t: tier, v: weekly mention total, ev: effectiveVolume,
 *     p: positive%, wow: WoW%,
 *     pl: {x, tt, ig, r, bs},   // classified SAMPLE breakdown (counts of posts we read)
 *     c:  {r, bs, x, wv},       // weekly COUNTERS (true uncapped volume; null = absent)
 *     q: [{t, p, a, u}], u: updated_date, r: rank }
 *
 * Counters live in `c`, NOT `pl` — sample counts and true counters are
 * different units (the v2 `xv` top-level precedent, generalized).
 * Legacy v2 files still parse client-side; the card treats missing keys
 * as absent.
 */
function writePublicFile(showId, scored, counters) {
  ensureDir(PUBLIC_SHOWS_DIR);
  const compact = {
    _v: 3,
    t: scored.tier,
    v: scored.volume,
    ev: scored.effectiveVolume,
    p: scored.positivePct,
    os: scored.opinionSample,
    wow: scored.weekOverWeekPct,
    pl: {
      x: scored.platformBreakdown.x,
      tt: scored.platformBreakdown.tiktok,
      ig: scored.platformBreakdown.instagram,
      r: scored.platformBreakdown.reddit,
      bs: scored.platformBreakdown.bluesky,
    },
    c: {
      r: counters.reddit,
      bs: counters.bluesky,
      x: counters.x,
      wv: counters.wikipedia,
    },
    q: scored.topQuotes.map((q) => ({
      t: q.text,
      p: q.platform,
      a: q.author,
      u: q.url,
    })),
    u: new Date().toISOString(),
  };
  const file = path.join(PUBLIC_SHOWS_DIR, `${showId}.social.json`);
  fs.writeFileSync(file, JSON.stringify(compact));
}

// ---------- Per-show processing ----------

async function processShow({ show, wikiTitles, openaiApiKey, dryRun, logger = console }) {
  const showId = show.id;
  const showTitle = show.title;
  const marketQualifier = getMarketQualifier(show);
  const marketLabel = getMarketLabel(show);

  logger.log(`[${showId}] Fetching pulse for "${showTitle}" (${marketLabel})...`);

  // Fetch social sources + Wikipedia counter in parallel
  const wikiTitle = wikiTitles[showId] || null;
  const [fetchResult, wikiViews] = await Promise.all([
    fetchAllPulseSources({
      showTitle,
      marketQualifier,
      redditMax: REDDIT_MAX,
      blueskyMax: BLUESKY_MAX,
      logger,
    }),
    wikiTitle ? fetchWeeklyPageviews(wikiTitle, { logger }) : Promise.resolve(null),
  ]);

  const counters = { ...fetchResult.counters, wikipedia: wikiViews };

  logger.log(
    `[${showId}]   counters: reddit=${counters.reddit ?? 'n/a'} bluesky=${counters.bluesky ?? 'n/a'} x=${counters.x ?? 'n/a'} wiki=${counters.wikipedia ?? 'n/a'} | sample=${fetchResult.mentions.length}`,
  );
  if (fetchResult.errors.length > 0) {
    logger.warn(`[${showId}]   platform errors: ${fetchResult.errors.map((e) => e.platform).join(', ')}`);
  }

  // Classify relevance + sentiment on the text sample
  const classified = await classifyMentions({
    mentions: fetchResult.mentions,
    showTitle,
    marketLabel,
    openaiApiKey,
    logger,
  });
  const relevantCount = classified.filter((m) => m.relevant).length;
  logger.log(`[${showId}]   relevant=${relevantCount}/${classified.length}`);

  // Prior v3 data for baseline/WoW (v2 ignored — semantics reset)
  const prior = loadPriorSocialPulse(showId);
  const baseline = prior?.baseline || null;
  const priorVolume = prior?.volume ?? null;

  const scored = computeSocialPulse({
    mentions: classified,
    counters,
    baseline,
    priorVolume,
  });

  logger.log(
    `[${showId}]   tier=${scored.tier} vol=${scored.volume} effVol=${scored.effectiveVolume} pos=${scored.positivePct}% wow=${scored.weekOverWeekPct ?? 'n/a'}%`,
  );

  const canonical = {
    _v: 3,
    showId,
    showTitle,
    market: marketLabel,
    fetchedAt: new Date().toISOString(),
    ...scored,
    counters,
    wikipediaTitle: wikiTitle,
    baseline: scored.nextBaseline, // persist the UPDATED baseline for next run
    rawCounts: fetchResult.rawCounts,
    errors: fetchResult.errors,
  };
  delete canonical.nextBaseline;

  if (!dryRun) {
    writeCanonicalFile(showId, canonical);
    writePublicFile(showId, scored, counters);
  } else {
    logger.log(`[${showId}]   (dry run — not writing files)`);
  }

  return {
    showId,
    tier: scored.tier,
    volume: scored.volume,
    counters,
    sampleSize: classified.length,
    relevantCount,
    errors: fetchResult.errors,
  };
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv);
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!openaiApiKey) {
    console.error('Missing OPENAI_API_KEY env var');
    process.exit(1);
  }

  let shows;
  if (args.allRunning) {
    shows = listRunningShows();
    console.log(`Processing ${shows.length} running shows`);
  } else {
    shows = [loadShow(args.showId)];
  }

  const wikiTitles = loadWikiTitleMap();
  const results = [];

  for (const show of shows) {
    try {
      const result = await processShow({
        show,
        wikiTitles,
        openaiApiKey,
        dryRun: args.dryRun,
        logger: console,
      });
      results.push(result);
    } catch (err) {
      console.error(`[${show.id}] FAILED: ${err.message}`);
      results.push({ showId: show.id, error: err.message });
    }

    // Politeness spacing between shows — Bluesky's public AppView has an
    // IP-level limit and Reddit's proxy fallback appreciates the breather.
    if (shows.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // ---------- Summary ----------
  console.log('\n=== Summary ===');
  const ok = results.filter((r) => !r.error);
  const failed = results.length - ok.length;
  const byTier = {};
  for (const r of ok) byTier[r.tier] = (byTier[r.tier] || 0) + 1;
  console.log(`Processed ${ok.length}/${results.length}, failures: ${failed}`);
  console.log('Tier breakdown:', byTier);

  // ---------- Fleet health guards ----------
  // Only meaningful for multi-show runs; a single-show run can't establish
  // fleet-level coverage. NOTE: the _meta.json freshness stamp is written
  // AFTER the guards — a guard-failed run must look stale to
  // health-check.js, not freshly updated.
  if (ok.length >= 10) {
    // Guard 6a: Bluesky counter coverage. Bluesky returns hitsTotal >= 0 on
    // success; null means the fetch failed (403 from datacenter IP without
    // BSKY secrets is the expected failure mode).
    const blueskyMissing = ok.filter((r) => r.counters.bluesky === null).length;
    if (blueskyMissing / ok.length > 0.5) {
      console.error(
        `COUNTER COVERAGE FAILED: ${blueskyMissing}/${ok.length} shows have no Bluesky counter. ` +
          'Likely 403 from datacenter IP — set BSKY_HANDLE + BSKY_APP_PASSWORD secrets. ' +
          'Refusing to publish an index computed from the surviving signals.',
      );
      process.exit(6);
    }

    // Guard 6b: Reddit fleet-wide zero. The Reddit fetcher swallows proxy
    // failures into empty results, so per-show zero is legal but fleet-wide
    // zero means the pipeline (or SCRAPINGBEE_API_KEY) is broken.
    const redditNull = ok.filter((r) => r.counters.reddit === null).length;
    const redditZero = ok.filter((r) => r.counters.reddit === 0).length;
    if (redditNull / ok.length > 0.9) {
      // Every provider is down and the fetcher SAID so (null = signal
      // absent). This is the designed degraded mode: the scorer drops the
      // Reddit signal and renormalizes with the coverage floor. Publish,
      // loudly — 2026-07: direct 403s, BD robots-gated, SD renders broken,
      // SB capped until its monthly reset.
      console.warn(
        `COUNTER COVERAGE DEGRADED: ${redditNull}/${ok.length} shows have Reddit=ABSENT ` +
          '(all providers down). Publishing with renormalized weights; Reddit rejoins ' +
          'automatically when a provider recovers.',
      );
    } else if (redditZero / ok.length > 0.9) {
      console.error(
        `COUNTER COVERAGE FAILED: ${redditZero}/${ok.length} shows have Reddit=0 ` +
          '(searches "succeeded" but found nothing fleet-wide — silent breakage).',
      );
      process.exit(6);
    }

    // Guard 4: sample pipeline health (classifier / text fetch). Kept from
    // the Apify era but on the SAMPLE, not volume: >30% of shows with zero
    // relevant classified mentions means the classifier or both text
    // sources broke.
    const zeroSample = ok.filter((r) => r.relevantCount === 0).length;
    // When Reddit is ABSENT fleet-wide (Guard 6b degraded mode), samples come
    // from Bluesky alone — zero-relevant is expected for quiet shows, so the
    // threshold relaxes; the guard still catches a Bluesky/classifier break.
    const redditAbsentFleetWide = redditNull / ok.length > 0.9;
    const zeroSampleThreshold = redditAbsentFleetWide ? 0.6 : 0.3;
    if (zeroSample / ok.length > zeroSampleThreshold) {
      console.error(
        `HEALTH CHECK FAILED: ${zeroSample}/${ok.length} shows returned 0 relevant sample mentions (${Math.round((zeroSample / ok.length) * 100)}%${redditAbsentFleetWide ? ', degraded threshold 60% — Reddit absent' : ''}).`,
      );
      process.exit(4);
    }
  }

  // Freshness stamp — only reached on a healthy run (guards above exit
  // before this on fleet-level failure).
  if (!args.dryRun) {
    writeRunMeta({
      shows: results.length,
      failures: failed,
      tierBreakdown: byTier,
    });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
