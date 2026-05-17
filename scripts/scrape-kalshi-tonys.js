#!/usr/bin/env node
/**
 * scrape-kalshi-tonys.js — Fetch Tony win-probability odds from Kalshi
 *
 * Kalshi REST API (no auth needed for market reads):
 *   GET https://api.elections.kalshi.com/trade-api/v2/events/{TICKER}?with_nested_markets=true
 *
 * Nominee odds come from market.last_price_dollars (0-1 scale).
 * custom_strike.Nominee holds the show/person name per market.
 *
 * Confirmed live event tickers (2026-05-17):
 *   KXTONYAWARDS-26BM  → Best Musical
 *   KXTONYAWARDS-26BP  → Best Play
 *
 * Usage:
 *   node scripts/scrape-kalshi-tonys.js [--season=2026] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT_MS = 30000;

// Confirmed live tickers → canonical Tony category names
const TICKER_TO_CATEGORY = {
  'KXTONYAWARDS-26BM': 'Best Musical',
  'KXTONYAWARDS-26BP': 'Best Play',
};

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCategoryOdds(ticker, categoryName) {
  const url = `${KALSHI_BASE}/events/${ticker}?with_nested_markets=true`;
  const data = await fetchWithTimeout(url);
  const event = data.event;

  if (!event || !event.markets || event.markets.length === 0) {
    console.error(`  [warn] ${ticker}: no event or markets found`);
    return null;
  }

  const nominees = {};
  let matched = 0;

  for (const m of event.markets) {
    // Skip "Tie" pseudo-nominees
    const nominee = m.custom_strike?.Nominee || m.no_sub_title;
    if (!nominee || nominee === 'Tie') continue;

    const price = parseFloat(m.last_price_dollars ?? '0');
    if (isNaN(price)) continue;

    nominees[nominee] = Math.max(0, Math.min(1, price));
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

  console.error(`Scraping Kalshi Tony odds for season ${season}...`);

  const categories = {};
  let fetchedCount = 0;

  for (const [ticker, categoryName] of Object.entries(TICKER_TO_CATEGORY)) {
    try {
      const result = await fetchCategoryOdds(ticker, categoryName);
      if (result) {
        categories[categoryName] = result;
        fetchedCount++;
      }
    } catch (err) {
      console.error(`  [warn] ${ticker}: ${err.message}`);
    }
  }

  const output = {
    _meta: {
      source: 'kalshi',
      lastUpdated: new Date().toISOString(),
      season,
      categoriesFetched: fetchedCount,
    },
    categories,
  };

  if (fetchedCount === 0) {
    console.error('\n[info] No live Kalshi Tony markets found.');
  } else {
    console.error(`\nFetched ${fetchedCount} categories`);
  }

  const outPath = path.join(__dirname, '..', 'data', 'tony-kalshi-odds.json');
  if (dryRun) {
    console.log(JSON.stringify(output, null, 2));
    console.error('--dry-run: output to stdout only');
  } else {
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.error(`Wrote ${outPath}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
