#!/usr/bin/env node
/**
 * scrape-kalshi-tonys.js — Fetch Tony win-probability odds from Kalshi
 *
 * Kalshi REST API (no auth needed for market reads):
 *   GET https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXTONYAWARDS
 *   GET https://api.elections.kalshi.com/trade-api/v2/events/{TICKER}?with_nested_markets=true
 *
 * Series API returns ALL active Tony events dynamically — no hardcoded tickers needed.
 * Each event's markets hold nominees with last_price_dollars (0–1 scale).
 *
 * Usage:
 *   node scripts/scrape-kalshi-tonys.js [--season=2026] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT_MS = 30000;

// Kalshi event title → canonical Tony category name
// Kalshi uses "Best Performance by an Actor/Actress..." for acting categories
// and sometimes lowercase "play" — normalize all variants here.
const KALSHI_TO_TONY = {
  // Show-level categories (already canonical or close)
  'Best Musical': 'Best Musical',
  'Best Play': 'Best Play',
  'Best Revival of a Musical': 'Best Revival of a Musical',
  'Best Revival of a Play': 'Best Revival of a Play',
  'Best Book of a Musical': 'Best Book of a Musical',
  'Best Choreography': 'Best Choreography',
  'Best Orchestrations': 'Best Orchestrations',
  'Best Direction of a Musical': 'Best Direction of a Musical',
  'Best Direction of a Play': 'Best Direction of a Play',

  // Acting — Kalshi uses full "Performance by..." wording
  'Best Performance by an Actor in a Leading Role in a Musical': 'Best Actor in a Musical',
  'Best Performance by an Actress in a Leading Role in a Musical': 'Best Actress in a Musical',
  'Best Performance by an Actor in a Leading Role in a Play': 'Best Actor in a Play',
  'Best Performance by an Actress in a Leading Role in a Play': 'Best Actress in a Play',
  'Best Performance by an Actor in a Featured Role in a Musical': 'Best Featured Actor in a Musical',
  'Best Performance by an Actress in a Featured Role in a Musical': 'Best Featured Actress in a Musical',
  // Kalshi uses lowercase "play" for some featured categories
  'Best Performance by an Actor in a Featured Role in a play': 'Best Featured Actor in a Play',
  'Best Performance by an Actress in a Featured Role in a play': 'Best Featured Actress in a Play',
  'Best Performance by an Actor in a Featured Role in a Play': 'Best Featured Actor in a Play',
  'Best Performance by an Actress in a Featured Role in a Play': 'Best Featured Actress in a Play',

  // Technical / design
  'Best Original Score (Music and/or Lyrics) Written for the Theatre': 'Best Original Score',
  'Best Original Score': 'Best Original Score',
  'Best Scenic Design of a Musical': 'Best Scenic Design of a Musical',
  'Best Scenic Design of a Play': 'Best Scenic Design of a Play',
  'Best Costume Design of a Musical': 'Best Costume Design of a Musical',
  'Best Costume Design of a Play': 'Best Costume Design of a Play',
  'Best Lighting Design of a Play': 'Best Lighting Design of a Play',
  'Best Lighting Design of a Musical': 'Best Lighting Design of a Musical',
  'Best Sound Design of a Musical': 'Best Sound Design of a Musical',
  'Best Sound Design of a Play': 'Best Sound Design of a Play',
};

function normalizeKalshiTitle(title) {
  if (!title) return null;
  // Strip "Tony Award for " prefix and trailing "?" that Kalshi adds to event titles
  let cleaned = title.replace(/^Tony Award for /i, '').replace(/\?$/, '').trim();
  // Direct lookup first (try both original and cleaned)
  if (KALSHI_TO_TONY[title]) return KALSHI_TO_TONY[title];
  if (KALSHI_TO_TONY[cleaned]) return KALSHI_TO_TONY[cleaned];
  // Case-insensitive fallback
  const lower = cleaned.toLowerCase();
  for (const [k, v] of Object.entries(KALSHI_TO_TONY)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

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

async function fetchSeriesEvents(seriesTicker) {
  const url = `${KALSHI_BASE}/events?series_ticker=${seriesTicker}&limit=100`;
  const data = await fetchWithTimeout(url);
  return data.events || [];
}

async function fetchEventWithMarkets(ticker) {
  const url = `${KALSHI_BASE}/events/${ticker}?with_nested_markets=true`;
  const data = await fetchWithTimeout(url);
  return data.event;
}

async function fetchCategoryOdds(ticker, kalshiTitle) {
  const canonicalName = normalizeKalshiTitle(kalshiTitle);
  if (!canonicalName) {
    console.error(`  [skip] ${ticker}: unknown Kalshi title "${kalshiTitle}" — add to KALSHI_TO_TONY map`);
    return null;
  }

  const event = await fetchEventWithMarkets(ticker);
  if (!event || !event.markets || event.markets.length === 0) {
    console.error(`  [warn] ${ticker}: no event or markets found`);
    return null;
  }

  const nominees = {};
  let matched = 0;

  for (const m of event.markets) {
    // Skip "Tie" pseudo-nominees
    const nominee = m.custom_strike?.Nominee || m.no_sub_title;
    if (!nominee || nominee.toLowerCase() === 'tie') continue;

    const price = parseFloat(m.last_price_dollars ?? '0');
    if (isNaN(price)) continue;

    nominees[nominee] = Math.max(0, Math.min(1, price));
    matched++;
  }

  if (matched === 0) {
    console.error(`  [warn] ${ticker}: markets found but no valid nominees`);
    return null;
  }

  console.error(`  [ok] ${canonicalName}: ${matched} nominees`);
  return { canonicalName, nominees };
}

async function main() {
  const args = process.argv.slice(2);
  const seasonArg = args.find(a => a.startsWith('--season='));
  const season = seasonArg ? parseInt(seasonArg.split('=')[1], 10) : 2026;
  const dryRun = args.includes('--dry-run');

  console.error(`Scraping Kalshi Tony odds for season ${season}...`);
  console.error('Fetching series events from Kalshi API...');

  // Discover all Tony events dynamically from the series
  let seriesEvents;
  try {
    seriesEvents = await fetchSeriesEvents('KXTONYAWARDS');
  } catch (err) {
    console.error(`[fatal] Failed to fetch series: ${err.message}`);
    process.exit(1);
  }

  if (!seriesEvents || seriesEvents.length === 0) {
    console.error('[info] No active Kalshi Tony events found. Markets may not exist yet for this season.');
    const output = {
      _meta: { source: 'kalshi', lastUpdated: new Date().toISOString(), season, categoriesFetched: 0 },
      categories: {},
    };
    if (!dryRun) {
      const outPath = path.join(__dirname, '..', 'data', 'tony-kalshi-odds.json');
      fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
      console.error(`Wrote ${outPath}`);
    }
    process.exit(0);
  }

  console.error(`Found ${seriesEvents.length} series events, fetching nominee odds...`);

  const categories = {};
  let fetchedCount = 0;

  for (const event of seriesEvents) {
    const ticker = event.event_ticker;
    const kalshiTitle = event.title;

    try {
      const result = await fetchCategoryOdds(ticker, kalshiTitle);
      if (result) {
        categories[result.canonicalName] = { nominees: result.nominees };
        fetchedCount++;
      }
    } catch (err) {
      console.error(`  [warn] ${ticker}: ${err.message}`);
    }

    // Brief pause to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  // Snapshot current odds before overwriting (for day-over-day arrow display)
  const outPath = path.join(__dirname, '..', 'data', 'tony-kalshi-odds.json');
  let prevCategories = {};
  try { prevCategories = JSON.parse(fs.readFileSync(outPath, 'utf8')).categories || {}; } catch {}
  for (const [catName, catData] of Object.entries(categories)) {
    const prevNominees = prevCategories[catName]?.nominees;
    if (prevNominees) catData.prevNominees = prevNominees;
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

  console.error(`\nFetched ${fetchedCount} categories from ${seriesEvents.length} events`);
  if (fetchedCount < seriesEvents.length) {
    const skipped = seriesEvents.length - fetchedCount;
    console.error(`[info] ${skipped} events skipped (unknown titles or empty markets)`);
  }

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
