#!/usr/bin/env node
/**
 * fetch-social-pulse.js — fetches social mentions for a single show (or all
 * running shows), classifies them with GPT-4o-mini, scores them with the
 * social-pulse-scorer library, and writes two output files per show:
 *
 *   1. data/social-pulse/{show-id}.json       — canonical source
 *   2. public/data/shows/{show-id}.social.json — compact client-ready
 *
 * Writing to a SIBLING public file (not merging into the main show JSON)
 * eliminates the race with nightly generate-mobile-show-details.js rebuilds
 * (see plan-review pre-mortem scenario for why this matters).
 *
 * Usage:
 *   node scripts/fetch-social-pulse.js --show-id=maybe-happy-ending-2024
 *   node scripts/fetch-social-pulse.js --all-running
 *   node scripts/fetch-social-pulse.js --show-id=X --dry-run  (no writes)
 *
 * Required env:
 *   APIFY_TOKEN
 *   OPENAI_API_KEY
 *
 * Budget safety:
 *   - Reads data/social-pulse/_budget.json before EACH show to check
 *     cumulative monthly spend against a $4.50 soft cap (leaves $0.50
 *     headroom under Apify's free-tier $5 hard cap).
 *   - Aborts if over the cap.
 *   - Writes updated cumulative spend after each show.
 */

const fs = require('fs');
const path = require('path');

const { fetchAllSocialMentions, fetchXTweetCount } = require('./lib/apify-fetchers');
const { classifyMentions } = require('./lib/social-pulse-llm');
const { computeSocialPulse } = require('./lib/social-pulse-scorer');
const { listRunningShows } = require('./lib/list-running-shows');

const REPO_ROOT = path.join(__dirname, '..');
const SOCIAL_PULSE_DIR = path.join(REPO_ROOT, 'data', 'social-pulse');
const PUBLIC_SHOWS_DIR = path.join(REPO_ROOT, 'public', 'data', 'shows');
const BUDGET_FILE = path.join(SOCIAL_PULSE_DIR, '_budget.json');

// Volume limits. Bumped 2026-04-11 after the user noted "only 10 TikToks for
// Cats feels off" — the old caps were saturating on hot shows. New caps:
//   X:         100 → 150  (+$9.10/mo, cheap at $0.00025/tweet)
//   TikTok:    10 → 20    (+$10.92/mo, the expensive platform)
//   Instagram: 15 (unchanged — already plenty for the platform's signal)
// Total est ~$33/mo, comfortably under $39 Creator plan credits.
const TWITTER_MAX = 150;
const TIKTOK_MAX = 20;
const INSTAGRAM_MAX = 15;
// Reddit via brand-mention-sources.js fetchRedditMentions. 100 is Reddit's
// own API ceiling per query (not ours). Effectively uncapped for theater
// volumes — hot shows typically return 20-80 posts.
const REDDIT_MAX = 100;

// Soft cap for cumulative monthly Apify spend. Apify ceiling raised to $75
// (2026-04-12). Weekly runs cost ~$10 each, 4 runs/mo = ~$40. $65 cap
// leaves $10 headroom for retries and ad-hoc single-show runs.
const BUDGET_SOFT_CAP_USD = 65.0;

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

// ---------- Budget tracking ----------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readBudget() {
  if (!fs.existsSync(BUDGET_FILE)) {
    return { month: currentMonthKey(), cumulativeUsd: 0, runs: 0 };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf-8'));
    // Reset cumulative spend on month rollover
    if (raw.month !== currentMonthKey()) {
      return { month: currentMonthKey(), cumulativeUsd: 0, runs: 0 };
    }
    return raw;
  } catch {
    return { month: currentMonthKey(), cumulativeUsd: 0, runs: 0 };
  }
}

function writeBudget(budget) {
  ensureDir(SOCIAL_PULSE_DIR);
  // lastUpdated drives the daily-digest freshness check for /trending data.
  // Without it the directory rots silently if the Monday workflow breaks.
  budget.lastUpdated = new Date().toISOString();
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 2));
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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

function loadPriorSocialPulse(showId) {
  const file = path.join(SOCIAL_PULSE_DIR, `${showId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
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
 * Writes the compact client-ready sibling public file. Separate from the
 * main public show JSON (intentionally — see header comment on race
 * conditions with generate-mobile-show-details.js).
 *
 * Schema uses short keys to keep the payload tiny:
 *   { _v: 2, t: tier, v: volume, p: positive%, wow: WoW%, bm: baselineMultiple,
 *     pl: {x, tt, ig, r}, q: [{t, p, a, u}], u: updated_date, r: rank }
 *
 * Schema v2 (2026-04-11): added pl.r (reddit count). Legacy v1 files
 * still parse — the card defaults missing pl.r to 0.
 */
function writePublicFile(showId, scored, xTrueVolume) {
  ensureDir(PUBLIC_SHOWS_DIR);
  const compact = {
    _v: 2,
    t: scored.tier,
    v: scored.volume,
    p: scored.positivePct,
    wow: scored.weekOverWeekPct,
    bm: scored.baselineMultiple,
    pl: {
      x: scored.platformBreakdown.x,
      tt: scored.platformBreakdown.tiktok,
      ig: scored.platformBreakdown.instagram,
      r: scored.platformBreakdown.reddit,
    },
    // True X volume from free X API (uncapped). The card uses this instead
    // of pl.x (which is capped at 150 by Apify) for meaningful volume display.
    xv: xTrueVolume ?? undefined,
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

async function processShow({ show, apifyToken, openaiApiKey, dryRun, logger = console }) {
  const showId = show.id;
  const showTitle = show.title;
  const marketQualifier = getMarketQualifier(show);
  const marketLabel = getMarketLabel(show);

  logger.log(`[${showId}] Fetching mentions for "${showTitle}" (${marketLabel})...`);

  // Step 1a: Fetch mentions from all four platforms (Reddit + 3 Apify)
  // Step 1b: Fetch true X tweet count via free X API (runs in parallel)
  const [fetchResult, xTrueVolume] = await Promise.all([
    fetchAllSocialMentions({
      showTitle,
      marketQualifier,
      twitterMax: TWITTER_MAX,
      tiktokMax: TIKTOK_MAX,
      instagramMax: INSTAGRAM_MAX,
      redditMax: REDDIT_MAX,
      token: apifyToken,
      logger,
    }),
    fetchXTweetCount({ showTitle, marketQualifier, logger }),
  ]);

  const xVolLabel = xTrueVolume !== null ? `X.vol=${xTrueVolume}` : 'X.vol=n/a';
  logger.log(
    `[${showId}]   Reddit=${fetchResult.rawCounts.reddit || 0} X=${fetchResult.rawCounts.twitter} ${xVolLabel} TikTok=${fetchResult.rawCounts.tiktok} IG=${fetchResult.rawCounts.instagram} total=${fetchResult.mentions.length} cost=$${fetchResult.costUsd.toFixed(4)}`,
  );

  if (fetchResult.errors.length > 0) {
    logger.warn(`[${showId}]   platform errors: ${fetchResult.errors.map((e) => e.platform).join(', ')}`);
  }

  // Step 2: Classify relevance + sentiment
  const classified = await classifyMentions({
    mentions: fetchResult.mentions,
    showTitle,
    marketLabel,
    openaiApiKey,
    logger,
  });

  const relevantCount = classified.filter((m) => m.relevant).length;
  logger.log(`[${showId}]   relevant=${relevantCount}/${classified.length}`);

  // Step 3: Load prior baseline + prior volume
  const prior = loadPriorSocialPulse(showId);
  const baseline = prior?.baseline || null;
  const priorVolume = prior?.volume || null;

  // Step 4: Score
  const scored = computeSocialPulse({
    mentions: classified,
    baseline,
    priorVolume,
  });

  logger.log(
    `[${showId}]   tier=${scored.tier} vol=${scored.volume} pos=${scored.positivePct}% baseMult=${scored.baselineMultiple ?? 'n/a'} wow=${scored.weekOverWeekPct ?? 'n/a'}%`,
  );

  // Step 5: Persist
  const canonical = {
    _v: 2,
    showId,
    showTitle,
    market: marketLabel,
    fetchedAt: new Date().toISOString(),
    ...scored,
    // True X volume from the free X API (uncapped, unlike Apify's capped sample)
    xTrueVolume: xTrueVolume ?? null,
    baseline: scored.nextBaseline, // persist the UPDATED baseline for next run
    costUsd: fetchResult.costUsd,
    rawCounts: fetchResult.rawCounts,
    errors: fetchResult.errors,
  };
  // Don't carry nextBaseline twice
  delete canonical.nextBaseline;

  if (!dryRun) {
    writeCanonicalFile(showId, canonical);
    writePublicFile(showId, scored, xTrueVolume);
  } else {
    logger.log(`[${showId}]   (dry run — not writing files)`);
  }

  return { showId, tier: scored.tier, volume: scored.volume, costUsd: fetchResult.costUsd, errors: fetchResult.errors };
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv);
  const apifyToken = process.env.APIFY_TOKEN;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!apifyToken) {
    console.error('Missing APIFY_TOKEN env var');
    process.exit(1);
  }
  if (!openaiApiKey) {
    console.error('Missing OPENAI_API_KEY env var');
    process.exit(1);
  }

  // Determine show list
  let shows;
  if (args.allRunning) {
    shows = listRunningShows();
    console.log(`Processing ${shows.length} running shows`);
  } else {
    const show = loadShow(args.showId);
    shows = [show];
  }

  // Budget check — refuses to start if already over cap
  const budget = readBudget();
  console.log(`Budget: $${budget.cumulativeUsd.toFixed(4)} / $${BUDGET_SOFT_CAP_USD} for ${budget.month}`);
  if (budget.cumulativeUsd >= BUDGET_SOFT_CAP_USD) {
    console.error(`BUDGET EXCEEDED — cumulative spend $${budget.cumulativeUsd.toFixed(4)} ≥ cap $${BUDGET_SOFT_CAP_USD}. Aborting.`);
    process.exit(3);
  }

  const results = [];
  for (const show of shows) {
    // Re-check budget before each show (parallel loops could push it over)
    const currentBudget = readBudget();
    if (currentBudget.cumulativeUsd >= BUDGET_SOFT_CAP_USD) {
      console.error(
        `BUDGET reached mid-loop at $${currentBudget.cumulativeUsd.toFixed(4)}. Stopping after ${results.length}/${shows.length} shows.`,
      );
      break;
    }

    try {
      const result = await processShow({
        show,
        apifyToken,
        openaiApiKey,
        dryRun: args.dryRun,
        logger: console,
      });
      results.push(result);

      if (!args.dryRun) {
        currentBudget.cumulativeUsd += result.costUsd;
        currentBudget.runs++;
        writeBudget(currentBudget);
      }
    } catch (err) {
      console.error(`[${show.id}] FAILED: ${err.message}`);
      results.push({ showId: show.id, error: err.message });
    }

    // Small spacing between shows — Apify actors are rate-limited at the
    // platform level (Twitter, TikTok) but we're polite anyway.
    if (shows.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  const byTier = {};
  let totalCost = 0;
  let failed = 0;
  for (const r of results) {
    if (r.error) {
      failed++;
      continue;
    }
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    totalCost += r.costUsd || 0;
  }
  console.log(`Processed ${results.length - failed}/${results.length}, failures: ${failed}`);
  console.log(`Total Apify cost this run: $${totalCost.toFixed(4)}`);
  console.log('Tier breakdown:', byTier);

  // Detect Apify account-level budget exhaustion. When the monthly hard
  // limit is hit, every Apify actor returns 403 with this message — the
  // health check below would otherwise call it "an actor is broken,"
  // which sends you chasing a code bug instead of the real fix
  // (raise the cap at https://console.apify.com/billing).
  const APIFY_BUDGET_RE = /Monthly usage hard limit exceeded/i;
  const APIFY_PLATFORMS = new Set(['x', 'tiktok', 'instagram']);
  const showsWithApifyBudgetError = results.filter((r) =>
    (r.errors || []).some(
      (e) => APIFY_PLATFORMS.has(e.platform) && APIFY_BUDGET_RE.test(e.error || ''),
    ),
  ).length;
  const apifyBudgetExhausted =
    results.length > 0 && showsWithApifyBudgetError / results.length > 0.5;

  // Health check: if >30% of shows hit zero relevant mentions, surface as
  // exit code 4 for the workflow to catch.
  const zeroShows = results.filter((r) => !r.error && r.volume === 0).length;
  const zeroPct = results.length > 0 ? zeroShows / results.length : 0;
  if (zeroPct > 0.3) {
    if (apifyBudgetExhausted) {
      console.error(
        `APIFY BUDGET EXHAUSTED: ${showsWithApifyBudgetError}/${results.length} shows hit "Monthly usage hard limit exceeded" on Apify (X/TikTok/Instagram). Reddit + X-volume still ran. ACTION: raise the monthly hard limit or upgrade plan at https://console.apify.com/billing.`,
      );
      process.exit(5);
    }
    console.error(
      `HEALTH CHECK FAILED: ${zeroShows}/${results.length} shows returned 0 relevant mentions (${Math.round(zeroPct * 100)}%). This likely means an actor is broken.`,
    );
    process.exit(4);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
