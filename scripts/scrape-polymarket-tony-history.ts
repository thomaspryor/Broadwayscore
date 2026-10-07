#!/usr/bin/env node
/**
 * scrape-polymarket-tony-history.ts — Historical Tony Awards closing odds from Polymarket
 *
 * Polymarket Gamma + CLOB APIs are public REST (no auth needed for reads).
 *
 * Strategy:
 *   1) Each Tony category is a multi-market event keyed by the SLUG_CATALOG.
 *      Currently Polymarket only ran 3 categories for the 78th Tony Awards
 *      (2024-25 season — ceremony June 8, 2025): Best Musical, Best Play,
 *      Best Original Score. There is NO data for earlier seasons (2023-24
 *      Outsiders/Stereophonic) or 2022-23 (Kimberly Akimbo/Leopoldstadt).
 *      Probed slugs: tony-awards-best-musical-2024, tonys-2024, tony-2024-best-musical,
 *      will-the-outsiders-win-the-tony-for-best-musical-2024, etc. — all return 0 events.
 *
 *   2) For each event we pull markets[] (one per nominee). Each market has:
 *        - question: 'Will "Show Name" win the Tony for Best ... 2025?'
 *        - outcomePrices: post-resolution payout ['1','0'] or ['0','1']
 *        - clobTokenIds: pair of CLOB token IDs (Yes / No)
 *        - endDate: ceremony time
 *      The post-resolution outcomePrices tell us which show won (wonMarket).
 *
 *   3) The CLOSING IMPLIED PROBABILITY is the last trading price BEFORE the
 *      ceremony, fetched via CLOB prices-history:
 *        GET https://clob.polymarket.com/prices-history?market=<yesTokenId>&interval=all&fidelity=1440
 *      We pick the last point with t <= endDate seconds. If none, fall back to
 *      the last point overall.
 *
 *   4) Cross-reference winners to data/awards.json using normalizeTitle to
 *      populate winnerShowId (best-effort; falls back to null).
 *
 *   5) polymarketTopPick = nominee with the highest closing implied prob.
 *      polymarketHit = topPick === winner.
 *
 * Output: data/analysis/polymarket-tony-historical-odds.json
 *
 * Usage:
 *   tsx scripts/scrape-polymarket-tony-history.ts [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeTitle } = require('./lib/title-normalization');

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 30000;

// Catalog of event slugs we know exist on Polymarket for past Tony seasons.
// As of 2026-05-26, ONLY the 78th Tony Awards (2024-25 season, ceremony 2025-06-08)
// have historical category-level Polymarket markets, and only for 3 categories.
// Add new entries here once Polymarket creates markets for the 2026 ceremony OR
// if pre-2025 markets are ever published.
interface SlugEntry {
  slug: string;
  season: string;
  tonyCategory: string;
}

const SLUG_CATALOG: SlugEntry[] = [
  { slug: 'tony-awards-best-musical',        season: '2024-25', tonyCategory: 'Best Musical' },
  { slug: 'tony-awards-best-play',           season: '2024-25', tonyCategory: 'Best Play' },
  { slug: 'tony-awards-best-original-score', season: '2024-25', tonyCategory: 'Best Original Score' },
];

interface PolyMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  endDate: string;
  closedTime?: string;
  closed?: boolean;
  lastTradePrice?: number;
  volumeNum?: number;
}

interface PolyEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  endDate: string;
  closed: boolean;
  markets: PolyMarket[];
}

interface PriceHistoryPoint { t: number; p: number; }

async function fetchWithTimeout(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal as any,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Extract show/person name from market question. */
function extractNameFromQuestion(question: string): string | null {
  const m = question.match(/Will "(.+?)" win/) || question.match(/Will '(.+?)' win/);
  return m ? m[1] : null;
}

/** Parse JSON-encoded string field; return [] on failure. */
function parseJsonField<T>(s: string | undefined | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Fetch last trade price before (or at) the ceremony endDate. */
async function fetchClosingPrice(yesTokenId: string, endDateIso: string): Promise<number | null> {
  const endTs = Math.floor(new Date(endDateIso).getTime() / 1000);
  const url = `${CLOB_BASE}/prices-history?market=${yesTokenId}&interval=all&fidelity=1440`;
  let data: any;
  try {
    data = await fetchWithTimeout(url);
  } catch (err: any) {
    console.error(`    [warn] price-history fetch failed: ${err.message}`);
    return null;
  }
  const history: PriceHistoryPoint[] = (data && data.history) || [];
  if (!history.length) return null;

  // Last point with t <= endTs (pre-ceremony close)
  const preCeremony = history.filter(p => p.t <= endTs);
  const last = preCeremony.length ? preCeremony[preCeremony.length - 1] : history[history.length - 1];
  return last && typeof last.p === 'number' ? last.p : null;
}

interface ClosingPriceRow {
  showTitle: string;
  impliedProb: number | null;
  resolvedYesPrice: number;   // 1 = won, 0 = lost (from outcomePrices)
  wonMarket: boolean;
  clobYesTokenId: string;
  marketSlug: string;
  marketEndDate: string;
}

interface RaceRow {
  season: string;
  tonyCategory: string;
  polymarketEventSlug: string;
  polymarketEventId: string;
  ceremonyEndDate: string;
  closingPrices: ClosingPriceRow[];
  winnerShowTitle: string | null;
  winnerShowId: string | null;
  polymarketTopPick: string | null;
  polymarketHit: boolean | null;
  notes?: string;
}

/** Load awards.json for winner cross-reference. */
function loadAwardsIndex(): Map<string, string[]> {
  const awardsPath = path.join(__dirname, '..', 'data', 'awards.json');
  if (!fs.existsSync(awardsPath)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(awardsPath, 'utf8'));
    const shows = raw.shows || {};
    // Map normalizedTitle → [showId, showId, ...]
    // We also use the showId itself as a fallback title hint (slugged form).
    const idx = new Map<string, string[]>();
    for (const [showId, info] of Object.entries<any>(shows)) {
      const candidates: string[] = [];
      if (info?.title) candidates.push(info.title);
      // showId without trailing -YYYY is a usable slug-style title
      candidates.push(showId.replace(/-(\d{4})$/, '').replace(/-/g, ' '));
      for (const cand of candidates) {
        const norm = normalizeTitle(cand);
        if (!norm) continue;
        const arr = idx.get(norm) || [];
        if (!arr.includes(showId)) arr.push(showId);
        idx.set(norm, arr);
      }
    }
    return idx;
  } catch (err: any) {
    console.error(`[warn] awards.json load failed: ${err.message}`);
    return new Map();
  }
}

function resolveWinnerShowId(
  winnerTitle: string,
  season: string,
  awardsIndex: Map<string, string[]>,
): string | null {
  const norm = normalizeTitle(winnerTitle);
  const candidates = awardsIndex.get(norm) || [];
  if (!candidates.length) return null;
  // Prefer one whose showId year matches the SECOND half of the season
  // (2024-25 → 2025). Tony years use the season-end year.
  const yearMatch = season.match(/(\d{4})-(\d{2})/);
  if (yearMatch) {
    const fullEndYear = `20${yearMatch[2]}`;
    const exact = candidates.find(id => id.endsWith(`-${fullEndYear}`));
    if (exact) return exact;
    // Fallback: also try start-year (some shows are filed under opening year)
    const startYear = yearMatch[1];
    const startExact = candidates.find(id => id.endsWith(`-${startYear}`));
    if (startExact) return startExact;
  }
  // Otherwise return the first
  return candidates[0];
}

async function processEvent(
  entry: SlugEntry,
  event: PolyEvent,
  awardsIndex: Map<string, string[]>,
): Promise<RaceRow> {
  const markets = event.markets || [];
  const closingPrices: ClosingPriceRow[] = [];
  let winnerTitle: string | null = null;

  for (const m of markets) {
    const name = extractNameFromQuestion(m.question || '');
    if (!name) {
      console.error(`    [skip] unparseable question: ${m.question}`);
      continue;
    }
    const outcomePrices = parseJsonField<string[]>(m.outcomePrices, ['0', '0']);
    const resolvedYesPrice = parseFloat(outcomePrices[0] || '0') || 0;
    const wonMarket = resolvedYesPrice >= 0.999;

    const clobTokenIds = parseJsonField<string[]>(m.clobTokenIds, []);
    const yesTokenId = clobTokenIds[0];
    let impliedProb: number | null = null;
    if (yesTokenId) {
      impliedProb = await fetchClosingPrice(yesTokenId, m.endDate || event.endDate);
    }

    closingPrices.push({
      showTitle: name,
      impliedProb,
      resolvedYesPrice,
      wonMarket,
      clobYesTokenId: yesTokenId || '',
      marketSlug: m.slug,
      marketEndDate: m.endDate,
    });

    if (wonMarket) winnerTitle = name;
  }

  // Top pick = highest closing implied prob (fall back to bestBid surrogate)
  let topPick: string | null = null;
  let topProb = -1;
  for (const row of closingPrices) {
    if (typeof row.impliedProb === 'number' && row.impliedProb > topProb) {
      topProb = row.impliedProb;
      topPick = row.showTitle;
    }
  }

  const winnerShowId = winnerTitle ? resolveWinnerShowId(winnerTitle, entry.season, awardsIndex) : null;
  const polymarketHit = winnerTitle && topPick ? winnerTitle === topPick : null;

  return {
    season: entry.season,
    tonyCategory: entry.tonyCategory,
    polymarketEventSlug: event.slug,
    polymarketEventId: event.id,
    ceremonyEndDate: event.endDate,
    closingPrices,
    winnerShowTitle: winnerTitle,
    winnerShowId,
    polymarketTopPick: topPick,
    polymarketHit,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.error(`Fetching ${SLUG_CATALOG.length} Polymarket Tony events...`);

  // Single multi-slug fetch
  const slugParams = SLUG_CATALOG.map(e => `slug=${encodeURIComponent(e.slug)}`).join('&');
  const url = `${GAMMA_BASE}/events?${slugParams}`;
  let events: PolyEvent[] = [];
  try {
    events = (await fetchWithTimeout(url)) as PolyEvent[];
  } catch (err: any) {
    console.error(`[fatal] events fetch failed: ${err.message}`);
    process.exit(1);
  }
  console.error(`  Got ${events.length} event(s) of ${SLUG_CATALOG.length} expected`);

  const awardsIndex = loadAwardsIndex();
  console.error(`  awards.json index: ${awardsIndex.size} normalized titles`);

  const eventBySlug = new Map<string, PolyEvent>();
  for (const e of events) eventBySlug.set(e.slug, e);

  const races: RaceRow[] = [];
  for (const entry of SLUG_CATALOG) {
    const event = eventBySlug.get(entry.slug);
    if (!event) {
      console.error(`  [miss] ${entry.slug} not found on Polymarket`);
      continue;
    }
    console.error(`  [event] ${entry.slug} (${(event.markets || []).length} markets)`);
    const row = await processEvent(entry, event, awardsIndex);
    races.push(row);
  }

  const seasonsCovered = Array.from(new Set(races.map(r => r.season))).sort();
  const output = {
    _meta: {
      generatedAt: new Date().toISOString(),
      source: 'polymarket-gamma-api',
      endpointBase: `${GAMMA_BASE}/`,
      clobBase: `${CLOB_BASE}/`,
      slugCatalogSize: SLUG_CATALOG.length,
      eventsFound: events.length,
      racesCollected: races.length,
      seasonsCovered,
      limitation: events.length < SLUG_CATALOG.length || seasonsCovered.length <= 1
        ? `Polymarket has limited Tony history (only ${seasonsCovered.length} season(s): ${seasonsCovered.join(', ')}). Pre-78th-Tony category-level markets do not exist.`
        : null,
    },
    races,
  };

  // Print summary
  console.error('\n=== Summary ===');
  console.error(`Seasons covered: ${seasonsCovered.join(', ') || '(none)'}`);
  console.error(`Races collected: ${races.length}`);
  let hits = 0, ratable = 0;
  for (const r of races) {
    if (r.polymarketHit === true) hits++;
    if (r.polymarketHit !== null) ratable++;
    const mark = r.polymarketHit === true ? 'HIT' : (r.polymarketHit === false ? 'MISS' : 'UNK');
    const probStr = r.closingPrices
      .map(c => `${c.showTitle}=${c.impliedProb === null ? 'null' : c.impliedProb.toFixed(3)}${c.wonMarket ? '*' : ''}`)
      .join(', ');
    console.error(`  [${mark}] ${r.season} ${r.tonyCategory}: winner=${r.winnerShowTitle} (id=${r.winnerShowId}) topPick=${r.polymarketTopPick}`);
    console.error(`         ${probStr}`);
  }
  if (ratable > 0) {
    console.error(`\nPolymarket top-pick hit rate: ${hits}/${ratable} = ${((hits / ratable) * 100).toFixed(1)}%`);
  }

  const outDir = path.join(__dirname, '..', 'data', 'analysis');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'polymarket-tony-historical-odds.json');

  if (dryRun) {
    console.log(JSON.stringify(output, null, 2));
    console.error('\n--dry-run: not writing file');
  } else {
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.error(`\nWrote ${outPath}`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
