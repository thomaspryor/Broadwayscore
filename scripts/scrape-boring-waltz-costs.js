#!/usr/bin/env node

/**
 * Scrape Weekly Operating Cost Data from u/Boring_Waltz_9545's Reddit Posts
 *
 * Fetches all Grosses Analysis and Post-Mortem posts, extracts
 * Weekly Operating Cost estimates per show, and fills gaps in commercial.json.
 *
 * Only the MOST RECENT estimate per show is kept. What it may write is
 * scripts/lib/waltz-cost-gap-fill.js (BRO-4666, owner decision 2026-10-05):
 * a missing weekly cost, or one that is our own estimate (industry-estimate,
 * deep-research); his own earlier figure when it moved >10%. Never a
 * reported figure. Every write is flagged as an estimate and names the post.
 *
 * Reads his r/Broadway posts from the Arctic Shift archive of Reddit (free,
 * no key; draft-reddit-opening-posts.js reads it too). Reddit refuses CI
 * runners' unauthenticated requests, so the plain fetch this used before
 * failed every week from 2026-04 on, and the proxies in scripts/lib/reddit-api.js
 * are capped or refused. Reddit through reddit-api.js stays as the fallback
 * for when the archive is down.
 *
 * Usage:
 *   node scripts/scrape-boring-waltz-costs.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { isRelevantPost, extractCostsFromPost } = require('./lib/reddit-grosses');
const { isBroadwayCategory } = require('./lib/venue-classification');

const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { KNOWN_ALIASES: SHARED_ALIASES } = require('./lib/show-matching');
const { createCommercialWriteGuard } = require('./lib/commercial-write-guard');
const { fetchWithFallback } = require('./lib/reddit-api');
const { decideWaltzCostWrite, waltzCostPatch, isPlausibleWeeklyCost } = require('./lib/waltz-cost-gap-fill');
const { commercialRecordErrors } = require('./lib/commercial-record-checks');
const { hasHelpFlag } = require('./lib/cli-help');

// Commercial-specific aliases (same as update-commercial-data.js)
const COMMERCIAL_ALIASES = {
  'hp cursed child': 'harry-potter',
  'hpatcc': 'harry-potter',
  'tlk': 'the-lion-king-1997',
  'bom': 'book-of-mormon',
  'dbh': 'death-becomes-her',
  'bvsc': 'buena-vista-social-club',
  'bttf': 'back-to-the-future',
  'wfe': 'water-for-elephants',
  'qov': 'queen-of-versailles',
  'poto': 'the-phantom-of-the-opera-1988',
  'deh': 'dear-evan-hansen-2016',
  'cfa': 'come-from-away-2017',
  'neil diamond musical': 'a-beautiful-noise-2022',
  'michael jackson musical': 'mj',
  'cabaret': 'cabaret-2024',
  'cabaret revival': 'cabaret-2024',
  'gypsy': 'gypsy-2024',
  'sunset boulevard': 'sunset-blvd-2024',
  'sunset blvd': 'sunset-blvd-2024',
  'giant musical': 'giant',
};

// ---------------------------------------------------------------------------
// CLI Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const USAGE = `Usage: node scripts/scrape-boring-waltz-costs.js [--dry-run]

Fills missing weekly operating costs in commercial.json from u/Boring_Waltz_9545's
r/Broadway Grosses Analysis / Post-Mortem posts (never over a reported figure).
  --dry-run   print the changes, write nothing`;

// ---------------------------------------------------------------------------
// Data Paths
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, '..', 'data');
const COMMERCIAL_CI_PATH = path.join(DATA_DIR, 'commercial.json');
const COMMERCIAL_LOCAL_PATH = path.join(
  process.env.HOME || '~',
  'broadway-scorecard-data',
  'commercial.json'
);

function getCommercialPath() {
  if (fs.existsSync(COMMERCIAL_CI_PATH)) return COMMERCIAL_CI_PATH;
  if (fs.existsSync(COMMERCIAL_LOCAL_PATH)) return COMMERCIAL_LOCAL_PATH;
  console.error('ERROR: commercial.json not found at either path');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Fetch His Posts: Arctic Shift archive first, Reddit as the fallback
// ---------------------------------------------------------------------------

const REDDIT_USER = 'Boring_Waltz_9545';
const ARCHIVE_SEARCH_URL = 'https://arctic-shift.photon-reddit.com/api/posts/search';
const LOOKBACK_DAYS = 365;
const ARCHIVE_MAX_PAGES = 5;

async function fetchArchivePage(params) {
  const url = `${ARCHIVE_SEARCH_URL}?${new URLSearchParams(params)}`;
  // The archive answers 422 "Timeout" on a slow query, often fine a few
  // seconds later: three attempts, 15s then 30s apart.
  for (let attempt = 1; ; attempt++) {
    let why;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'broadwayscorecard-waltz-costs/1.0' },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.data)) return body.data;
      why = `HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`;
    } catch (e) {
      why = e.message;
    }
    if (attempt >= 3) throw new Error(`archive ${why}`);
    const wait = 15_000 * attempt;
    console.warn(`  archive ${why}; retrying in ${wait / 1000}s`);
    await new Promise(r => setTimeout(r, wait));
  }
}

async function fetchFromArchive() {
  const posts = [];
  const after = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  let before = null;
  for (let page = 1; page <= ARCHIVE_MAX_PAGES; page++) {
    const params = { author: REDDIT_USER, subreddit: 'Broadway', after: String(after), limit: '100', sort: 'desc' };
    if (before) params.before = String(before);
    const batch = await fetchArchivePage(params);
    console.log(`  Archive page ${page}: ${batch.length} posts`);
    posts.push(...batch);
    if (batch.length < 100) break;
    before = Math.min(...batch.map(p => p.created_utc));
  }
  return posts;
}

async function fetchJSON(url) {
  const json = await fetchWithFallback(url);
  if (!json || typeof json !== 'object' || !json.data) {
    throw new Error(`Unexpected Reddit response for ${url}`);
  }
  return json;
}

async function fetchAllPosts() {
  console.log('Fetching his posts from the Arctic Shift archive...');
  try {
    const posts = await fetchFromArchive();
    if (posts.length > 0) {
      // Newest first: the extraction keeps the first estimate it sees per show.
      posts.sort((a, b) => b.created_utc - a.created_utc);
      const newest = new Date(posts[0].created_utc * 1000).toISOString().slice(0, 10);
      console.log(`Total posts fetched: ${posts.length} (newest ${newest})`);
      return posts;
    }
    console.warn('  Archive returned no posts; trying Reddit');
  } catch (e) {
    console.warn(`  Archive unavailable (${e.message}); trying Reddit`);
  }
  return fetchFromReddit();
}

async function fetchFromReddit() {
  const baseUrl = `https://www.reddit.com/user/${REDDIT_USER}/submitted.json?limit=100`;
  const allPosts = [];

  // Page 1
  console.log('Fetching Reddit posts (page 1)...');
  const page1 = await fetchJSON(baseUrl);
  if (page1?.data?.children) {
    allPosts.push(...page1.data.children.map(c => c.data));
  }
  console.log(`  Page 1: ${page1?.data?.children?.length || 0} posts`);

  // Page 2 (if there's an "after" token)
  const after = page1?.data?.after;
  if (after) {
    console.log('Fetching Reddit posts (page 2)...');
    const page2 = await fetchJSON(`${baseUrl}&after=${after}`);
    if (page2?.data?.children) {
      allPosts.push(...page2.data.children.map(c => c.data));
    }
    console.log(`  Page 2: ${page2?.data?.children?.length || 0} posts`);
  }

  console.log(`Total posts fetched: ${allPosts.length}`);
  return allPosts;
}

// ---------------------------------------------------------------------------
// isRelevantPost and extractCostsFromPost (his ***Show*** headings and
// "Estimated Weekly Operating Cost: $850k/week" lines) live in
// scripts/lib/reddit-grosses.js, with tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Show Matching
// ---------------------------------------------------------------------------

function buildShowLookup(shows) {
  const allAliases = { ...SHARED_ALIASES, ...COMMERCIAL_ALIASES };
  return { shows, aliases: allAliases };
}

function matchShowName(showName, lookup) {
  const { shows, aliases } = lookup;

  // 1. Check commercial aliases first
  const lowerName = showName.toLowerCase().trim();
  if (aliases[lowerName]) {
    const slug = aliases[lowerName];
    const show = shows.find(s => s.id === slug || s.slug === slug);
    if (show) return show;
  }

  // 2. Use shared matchTitleToShow (handles normalization, slug matching, etc.)
  // matchTitleToShow returns { show, confidence }; the show is what callers read.
  const matched = matchTitleToShow(showName, shows, { market: 'broadway' });
  if (matched && matched.confidence === 'high') return matched.show;

  return null;
}

// Skip west-end, off-broadway, off-west-end — delegates to the shared
// scripts/-side predicate rather than reimplementing it (see #1471).
const isBroadwayShow = isBroadwayCategory;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  console.log('=== Boring Waltz Weekly Cost Scraper ===');
  if (DRY_RUN) console.log('[DRY RUN MODE]\n');

  // Load data
  const commercialPath = getCommercialPath();
  console.log(`Commercial data: ${commercialPath}`);
  // Bound to the resolved CI-vs-local path (getCommercialPath()) rather than
  // the module's default-path singleton.
  const { loadCommercial, saveCommercial } = createCommercialWriteGuard(commercialPath);
  const commercial = loadCommercial();

  const shows = loadShows();
  const lookup = buildShowLookup(shows);

  // Fetch posts
  const posts = await fetchAllPosts();
  const relevantPosts = posts.filter(isRelevantPost);
  console.log(`Relevant posts (Grosses/Post-Mortem): ${relevantPosts.length}\n`);

  if (relevantPosts.length === 0) {
    console.log('No relevant posts found. Exiting.');
    process.exit(0);
  }

  // Posts are returned newest-first by Reddit.
  // Extract costs, keeping only the MOST RECENT estimate per show.
  const costByShow = new Map(); // showName → { cost, postTitle, postDate, permalink }

  for (const post of relevantPosts) {
    const postDate = post.created_utc ? new Date(post.created_utc * 1000).toISOString().slice(0, 10) : 'unknown';
    const entries = extractCostsFromPost(post.selftext);

    for (const entry of entries) {
      // A misread figure must not hide his older, valid one for the show.
      if (!isPlausibleWeeklyCost(entry.cost)) {
        console.log(`  Ignored implausible $${entry.cost.toLocaleString()} for "${entry.showName}" in "${post.title}"`);
        continue;
      }
      // Only keep the first (most recent) occurrence of each show
      if (!costByShow.has(entry.showName)) {
        costByShow.set(entry.showName, {
          cost: entry.cost,
          postTitle: post.title,
          postDate,
          permalink: post.permalink,
        });
      }
    }
  }

  console.log(`Unique shows with cost data: ${costByShow.size}\n`);

  // Match and update
  const stats = { matched: 0, updated: 0, added: 0, skipped: 0, unmatched: 0 };
  const changes = [];
  const unmatched = [];
  const kept = []; // reported figures his estimate did not replace
  const skippedOther = []; // every other skip, with its reason
  const seenSlugs = new Set();

  for (const [showName, data] of costByShow) {
    const show = matchShowName(showName, lookup);

    if (!show) {
      unmatched.push(showName);
      stats.unmatched++;
      continue;
    }

    const slug = show.slug || show.id;
    // Two spellings of one show ("Buena Vista Social Club" / "...Club-"):
    // costByShow is newest first, so the first one is his latest estimate.
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    if (!isBroadwayShow(show)) {
      stats.skipped++;
      skippedOther.push({ slug, reason: 'not a Broadway show' });
      continue;
    }

    stats.matched++;
    const existing = commercial.shows?.[slug];

    // We only update existing entries; decideWaltzCostWrite skips the rest.
    const decision = decideWaltzCostWrite(existing, data.cost);
    if (!decision.write) {
      stats.skipped++;
      if (existing && existing.weeklyRunningCost != null && /reported/.test(decision.reason)) {
        kept.push({ slug, cost: data.cost, existingCost: existing.weeklyRunningCost, reason: decision.reason });
      } else {
        skippedOther.push({ slug, reason: `${decision.reason}; his estimate $${data.cost.toLocaleString()}` });
      }
      continue;
    }

    const patch = waltzCostPatch(existing, data);
    const errors = commercialRecordErrors(slug, { ...existing, ...patch }, { showRecord: show, allRecords: commercial.shows });
    if (errors.length) {
      stats.skipped++;
      skippedOther.push({ slug, reason: `refused by the record checks: ${errors.join('; ')}` });
      continue;
    }

    const action = existing.weeklyRunningCost == null ? 'add' : 'update';
    changes.push({
      slug,
      showName,
      action,
      oldCost: existing.weeklyRunningCost,
      oldMethod: existing.costMethodology || null,
      newCost: data.cost,
      reason: decision.reason,
      postDate: data.postDate,
    });
    if (action === 'add') stats.added++;
    else stats.updated++;
    if (!DRY_RUN) Object.assign(existing, patch);
  }

  // Print summary
  console.log('\n=== Summary ===');
  console.log(`Matched: ${stats.matched}`);
  console.log(`Replaced an estimate: ${stats.updated}`);
  console.log(`Added (no prior cost): ${stats.added}`);
  console.log(`Skipped (reported figure, within 10%, or not in commercial.json): ${stats.skipped}`);
  console.log(`Unmatched: ${stats.unmatched}`);

  if (changes.length > 0) {
    console.log('\n--- Changes ---');
    for (const c of changes) {
      if (c.action === 'update') {
        console.log(`  UPDATE ${c.slug}: $${c.oldCost.toLocaleString()} (${c.oldMethod}) -> $${c.newCost.toLocaleString()} (${c.reason}, from ${c.postDate})`);
      } else {
        console.log(`  ADD    ${c.slug}: $${c.newCost.toLocaleString()} (from ${c.postDate})`);
      }
    }
  }

  if (kept.length > 0) {
    console.log('\n--- Reported figures kept (his estimate not applied) ---');
    for (const k of kept) {
      console.log(`  KEEP   ${k.slug}: $${k.existingCost.toLocaleString()} (${k.reason}); his estimate $${k.cost.toLocaleString()}`);
    }
  }

  if (skippedOther.length > 0) {
    console.log('\n--- Skipped ---');
    for (const s of skippedOther) {
      console.log(`  SKIP   ${s.slug}: ${s.reason}`);
    }
  }

  if (unmatched.length > 0) {
    console.log('\n--- Unmatched Shows ---');
    for (const name of unmatched) {
      console.log(`  ? ${name}`);
    }
  }

  // Write
  if (!DRY_RUN && changes.length > 0) {
    commercial._meta.lastUpdated = new Date().toISOString().slice(0, 10);
    saveCommercial(commercial);
    console.log(`\nWrote ${changes.length} changes to ${commercialPath}`);
  } else if (DRY_RUN && changes.length > 0) {
    console.log('\n[DRY RUN] No files written.');
  } else {
    console.log('\nNo changes needed.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
