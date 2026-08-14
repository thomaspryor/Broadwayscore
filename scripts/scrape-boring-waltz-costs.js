#!/usr/bin/env node

/**
 * Scrape Weekly Operating Cost Data from u/Boring_Waltz_9545's Reddit Posts
 *
 * Fetches all Grosses Analysis and Post-Mortem posts, extracts
 * Weekly Operating Cost estimates per show, and updates commercial.json.
 *
 * Only the MOST RECENT estimate per show is kept.
 * Only updates commercial.json if:
 *   - Show has no weeklyRunningCost yet, OR
 *   - Existing cost differs by >10%
 *
 * Usage:
 *   node scripts/scrape-boring-waltz-costs.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { isRelevantPost } = require('./lib/reddit-grosses');
const { isBroadwayCategory } = require('./lib/venue-classification');

const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { KNOWN_ALIASES: SHARED_ALIASES } = require('./lib/show-matching');
const { createCommercialWriteGuard } = require('./lib/commercial-write-guard');

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
// Reddit API Fetch
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  // Use fetch() instead of https.get() to avoid TLS fingerprinting blocks
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'BroadwayScorecard/1.0',
      'Accept': 'application/json',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });

  if (res.status === 429) {
    throw new Error(`Rate limited (429) fetching ${url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fetch All Relevant Posts (2 pages)
// ---------------------------------------------------------------------------

async function fetchAllPosts() {
  const baseUrl = 'https://www.reddit.com/user/Boring_Waltz_9545/submitted.json?limit=100';
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
    await sleep(2000); // Rate limit courtesy
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
// Filter Relevant Posts
// ---------------------------------------------------------------------------

// isRelevantPost moved to scripts/lib/reddit-grosses.js (shared with
// update-commercial-data.js) — imported above.

// ---------------------------------------------------------------------------
// Extract Show Names + Costs from Post Selftext
//
// Show names appear as ***Show Name*** or ***️Show Name*** (with emoji prefix)
// Costs appear as "Weekly Operating Cost: $XXXk/week" or
// "Estimated Weekly Operating Cost: $XXXk/week"
// ---------------------------------------------------------------------------

function parseDollarK(str) {
  if (!str) return null;
  const cleaned = str.trim().replace(/[,$]/g, '');

  // Handle K/k suffix
  if (/k$/i.test(cleaned)) {
    const val = parseFloat(cleaned.replace(/k$/i, ''));
    return isNaN(val) ? null : Math.round(val * 1000);
  }

  // Handle M/m suffix
  if (/m$/i.test(cleaned)) {
    const val = parseFloat(cleaned.replace(/m$/i, ''));
    return isNaN(val) ? null : Math.round(val * 1000000);
  }

  const val = parseFloat(cleaned);
  return isNaN(val) ? null : Math.round(val);
}

function extractCostsFromPost(selftext) {
  if (!selftext) return [];

  const results = [];

  // Split into lines for scanning
  const lines = selftext.split('\n');

  let currentShowName = null;

  for (const line of lines) {
    // Match show name: ***Show Name*** or ***️Show Name***
    // The ️ is a variation selector that may follow emoji characters
    const showMatch = line.match(/\*{3}\s*[^\w\s]*\s*([^*]+?)\s*\*{3}/);
    if (showMatch) {
      // Clean the show name: strip leading emoji/special chars
      let name = showMatch[1].trim();
      // Remove leading emoji characters (unicode ranges for common emoji)
      name = name.replace(/^[\u{1F300}-\u{1FEFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+\s*/u, '').trim();
      if (name) {
        currentShowName = name;
      }
    }

    // Match cost: (Estimated )?(Weekly )?(Operating|Running) Cost: $XXXk(-$YYYk)?(/week)?
    // Handle both single values ($650k) and ranges ($650-$700k, $650k-$700k)
    const costMatch = line.match(
      /(?:Estimated\s+)?(?:Weekly\s+)?(?:Operating|Running)\s+Cost:?\s*\$([\d.,]+[KkMm]?)(?:\s*[-–—]\s*\$?([\d.,]+[KkMm]?))?(?:\/week)?/i
    );
    if (costMatch && currentShowName) {
      let cost;
      if (costMatch[2]) {
        // Range: use midpoint. Inherit suffix from the second value if first lacks one.
        let lowStr = costMatch[1];
        let highStr = costMatch[2];
        // If lowStr has no K/M suffix but highStr does, inherit it
        if (!/[KkMm]$/.test(lowStr) && /[KkMm]$/i.test(highStr)) {
          lowStr += highStr.slice(-1);
        }
        const low = parseDollarK(lowStr);
        const high = parseDollarK(highStr);
        cost = (low && high) ? Math.round((low + high) / 2) : (low || high);
      } else {
        cost = parseDollarK(costMatch[1]);
      }
      if (cost && cost > 0) {
        results.push({ showName: currentShowName, cost });
      }
    }
  }

  return results;
}

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
  const matched = matchTitleToShow(showName, shows, { market: 'broadway' });
  if (matched && matched.confidence === 'high') return matched;

  return null;
}

// Skip west-end, off-broadway, off-west-end — delegates to the shared
// scripts/-side predicate rather than reimplementing it (see #1471).
const isBroadwayShow = isBroadwayCategory;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
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
  const costByShow = new Map(); // showName → { cost, postTitle, postDate }

  for (const post of relevantPosts) {
    const postDate = post.created_utc ? new Date(post.created_utc * 1000).toISOString().slice(0, 10) : 'unknown';
    const entries = extractCostsFromPost(post.selftext);

    for (const entry of entries) {
      // Only keep the first (most recent) occurrence of each show
      if (!costByShow.has(entry.showName)) {
        costByShow.set(entry.showName, {
          cost: entry.cost,
          postTitle: post.title,
          postDate,
        });
      }
    }
  }

  console.log(`Unique shows with cost data: ${costByShow.size}\n`);

  // Match and update
  const stats = { matched: 0, updated: 0, added: 0, skipped: 0, unmatched: 0 };
  const changes = [];
  const unmatched = [];

  for (const [showName, data] of costByShow) {
    const show = matchShowName(showName, lookup);

    if (!show) {
      unmatched.push(showName);
      stats.unmatched++;
      continue;
    }

    if (!isBroadwayShow(show)) {
      stats.skipped++;
      continue;
    }

    stats.matched++;
    const slug = show.slug || show.id;
    const existing = commercial.shows?.[slug];

    if (!existing) {
      // Show not in commercial.json at all - skip (we only update existing entries)
      stats.skipped++;
      continue;
    }

    const existingCost = existing.weeklyRunningCost;

    if (existingCost) {
      // Only update if differs by >10%
      const pctDiff = Math.abs(existingCost - data.cost) / existingCost;
      if (pctDiff <= 0.10) {
        stats.skipped++;
        continue;
      }
      // Update
      changes.push({
        slug,
        showName,
        action: 'update',
        oldCost: existingCost,
        newCost: data.cost,
        pctDiff: (pctDiff * 100).toFixed(1),
        postDate: data.postDate,
      });
      if (!DRY_RUN) {
        existing.weeklyRunningCost = data.cost;
        existing.costMethodology = 'reddit-standard';
      }
      stats.updated++;
    } else {
      // Add cost where none existed
      changes.push({
        slug,
        showName,
        action: 'add',
        newCost: data.cost,
        postDate: data.postDate,
      });
      if (!DRY_RUN) {
        existing.weeklyRunningCost = data.cost;
        existing.costMethodology = 'reddit-standard';
      }
      stats.added++;
    }
  }

  // Print summary
  console.log('\n=== Summary ===');
  console.log(`Matched: ${stats.matched}`);
  console.log(`Updated (>10% diff): ${stats.updated}`);
  console.log(`Added (no prior cost): ${stats.added}`);
  console.log(`Skipped (within 10% or not in commercial.json): ${stats.skipped}`);
  console.log(`Unmatched: ${stats.unmatched}`);

  if (changes.length > 0) {
    console.log('\n--- Changes ---');
    for (const c of changes) {
      if (c.action === 'update') {
        console.log(`  UPDATE ${c.slug}: $${c.oldCost.toLocaleString()} -> $${c.newCost.toLocaleString()} (${c.pctDiff}% diff, from ${c.postDate})`);
      } else {
        console.log(`  ADD    ${c.slug}: $${c.newCost.toLocaleString()} (from ${c.postDate})`);
      }
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
