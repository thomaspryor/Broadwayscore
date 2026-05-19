#!/usr/bin/env node
/**
 * scrape-polymarket-tonys.js — Fetch Tony win-probability odds from Polymarket Gamma API
 *
 * Polymarket Gamma API is public REST (no auth needed for reads).
 * Endpoint: GET https://gamma-api.polymarket.com/events?slug={slug}
 *
 * Each event has multiple markets — one per nominee. Each market has:
 *   outcomePrices: JSON string ["yesPrice", "noPrice"]  (0–1 scale)
 *   question: 'Will "Show/Person Name" win the Tony for Best ...'
 *
 * Verified slugs (2026-05-18 — all active 2026 markets use -winner suffix):
 *   tony-awards-best-musical-winner           → 4 active nominees
 *   tony-awards-best-play-winner              → 4 active nominees
 *   tony-awards-best-book-of-a-musical-winner → 4 active nominees
 *
 * NOTE: Without -winner, slugs point to resolved 2025 markets (all prices 0/1).
 * Acting/craft categories have no active Polymarket markets for 2026.
 *
 * NOTE: These slugs map to the MOST RECENT Tony season's markets. The 2025
 * markets (already closed) resolve to 0.00/1.00. When Polymarket creates 2026
 * markets, they may use the same slugs (overwriting) or new year-suffixed ones.
 * The script skips markets where closed=true and all prices are 0/1 (already resolved)
 * so stale 2025 data isn't written to the output file.
 *
 * Usage:
 *   node scripts/scrape-polymarket-tonys.js [--season=2026] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { titlesMatch, normalizeTitle } = require('./lib/title-normalization');

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 30000;

// Verified slugs → canonical Tony category names
// 2026 markets all use the "-winner" suffix. Slugs without the suffix resolve to 2025 markets.
const SLUG_TO_CATEGORY = {
  'tony-awards-best-musical-winner': 'Best Musical',
  'tony-awards-best-play-winner': 'Best Play',
  'tony-awards-best-book-of-a-musical-winner': 'Best Book of a Musical',
};

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractNameFromQuestion(question) {
  // 'Will "Maybe Happy Ending" win the Tony...' → 'Maybe Happy Ending'
  // 'Will \'Darren Criss\' win the Tony...' → 'Darren Criss'
  const m = question.match(/Will "(.+?)" win/) || question.match(/Will '(.+?)' win/);
  return m ? m[1] : null;
}

function isResolvedMarket(markets) {
  if (!markets || markets.length === 0) return false;
  return markets.every(m => {
    try {
      const prices = JSON.parse(m.outcomePrices || '["0","0"]');
      const yes = parseFloat(prices[0]);
      return yes === 0 || yes === 1;
    } catch {
      return false;
    }
  });
}

async function fetchCategoryOdds(slug, categoryName) {
  const url = `${GAMMA_BASE}/events?slug=${slug}`;
  const data = await fetchWithTimeout(url);

  if (!data || data.length === 0) {
    console.error(`  [info] ${slug}: no event found (markets not yet created)`);
    return null;
  }

  const event = data[0];
  const markets = event.markets || [];

  if (markets.length === 0) {
    console.error(`  [warn] ${slug}: event found but has no markets`);
    return null;
  }

  // Skip if all markets are already resolved (prior year's ceremony)
  if (isResolvedMarket(markets)) {
    console.error(`  [info] ${slug}: markets are resolved (prior season) — skipping`);
    return null;
  }

  const nominees = {};
  let matched = 0;

  for (const m of markets) {
    const name = extractNameFromQuestion(m.question || '');
    if (!name) continue;

    let yesPrice = 0;
    try {
      const prices = JSON.parse(m.outcomePrices || '["0","0"]');
      yesPrice = Math.max(0, Math.min(1, parseFloat(prices[0]) || 0));
    } catch {
      continue;
    }

    nominees[name] = yesPrice;
    matched++;
  }

  console.error(`  [ok] ${categoryName}: ${matched} nominees`);
  return { nominees };
}

async function main() {
  const args = process.argv.slice(2);
  const seasonArg = args.find(a => a.startsWith('--season='));
  const season = seasonArg ? parseInt(seasonArg.split('=')[1], 10) : 2026;
  const dryRun = args.includes('--dry-run');

  console.error(`Scraping Polymarket Tony odds for season ${season}...`);

  const categories = {};
  let fetchedCount = 0;

  for (const [slug, categoryName] of Object.entries(SLUG_TO_CATEGORY)) {
    try {
      const result = await fetchCategoryOdds(slug, categoryName);
      if (result) {
        categories[categoryName] = result;
        fetchedCount++;
      }
    } catch (err) {
      console.error(`  [warn] ${slug}: ${err.message}`);
      // non-zero exit so workflow surfaces warning annotation
    }
  }

  // Snapshot current odds before overwriting (for day-over-day arrow display)
  const outPath = path.join(__dirname, '..', 'data', 'tony-polymarket-odds.json');
  let prevCategories = {};
  try { prevCategories = JSON.parse(fs.readFileSync(outPath, 'utf8')).categories || {}; } catch {}
  for (const [catName, catData] of Object.entries(categories)) {
    const prevNominees = prevCategories[catName]?.nominees;
    if (prevNominees) catData.prevNominees = prevNominees;
  }

  const output = {
    _meta: {
      source: 'polymarket',
      lastUpdated: new Date().toISOString(),
      season,
      categoriesFetched: fetchedCount,
    },
    categories,
  };

  if (fetchedCount === 0) {
    console.error('\n[info] No live Polymarket Tony markets found. Output will be empty.');
    console.error('This is expected before Polymarket creates 2026 season markets (~2-4 weeks pre-ceremony).');
  } else {
    console.error(`\nFetched ${fetchedCount} categories`);
  }

  if (dryRun) {
    console.log(JSON.stringify(output, null, 2));
    console.error('--dry-run: output to stdout only');
  } else {
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.error(`Wrote ${outPath}`);
  }

  // Exit non-zero if we expected markets but got none (after June ceremony date, markets should exist)
  // For now: always exit 0 so "no markets yet" doesn't fail the workflow
  process.exit(0);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
