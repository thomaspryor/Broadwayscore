#!/usr/bin/env node
/**
 * scrape-kalshi-tony-history.ts — Pull historical Tony Awards betting odds from
 * the Kalshi public API and persist closing prices + winners per category.
 *
 * Why this script exists
 * ----------------------
 * The Broadway Scorecard project compares our Tony prediction model against
 * other signal sources (Gold Derby, Vegas-style markets). Kalshi (kalshi.com)
 * is the only CFTC-regulated US prediction market that has listed Tony
 * categories. If they have multi-year history, the resulting JSON becomes our
 * "market accuracy" benchmark. If they don't (the empirical finding — see
 * "Findings" below), we still write a deterministic snapshot so future runs
 * can detect when historical events appear.
 *
 * Endpoints used (all public, no auth required for read-only):
 *   GET /trade-api/v2/series?category=Entertainment&limit=...
 *     → enumerate every Entertainment series; we filter by ticker patterns.
 *   GET /trade-api/v2/events?series_ticker=<T>&limit=200
 *     → list every event (= category × season) under that series.
 *   GET /trade-api/v2/markets?event_ticker=<E>&limit=200
 *     → list every market (= nominee) for that event, with last_price + status
 *       + result.
 *
 * Findings on 2026-05-26 (documented for reproducibility — re-run will refresh):
 *   - KXTONYAWARDS is the canonical Tony Awards series ticker. It exists ONLY
 *     for the 2026 ceremony (25 events, e.g. KXTONYAWARDS-26BM = Best Musical).
 *     All markets are status=active with last_price=null (no trading yet at
 *     time of writing) and synthetic close_time=2026-12-31. No -25/-24/-23
 *     events exist.
 *   - Legacy single-category tickers (KXBESTMUSICAL, KXBESTPLAY, KXBESTREVIVAL,
 *     KXBESTREVIVALMUS, KXBESTACTORMUS, KXBESTACTORTONYAWARDS, KXBESTACRESSTONYS)
 *     each have exactly one event with sub_title "In 2025" but ZERO markets
 *     attached. They appear to be placeholder events that were never wired up
 *     with nominees.
 *   - Conclusion: Kalshi has no settled/historical Tony Awards markets. We
 *     write `noData: true` and seed the file with the 2026 active snapshot so
 *     a later cron can flip it to historical the moment 2026 settles.
 *
 * Output:
 *   data/analysis/kalshi-tony-historical-odds.json
 *
 * Usage:
 *   npx tsx scripts/scrape-kalshi-tony-history.ts
 *     # or via ts-node — uses fetch (Node 18+) and CommonJS require for awards.
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeTitle } = require('../scripts/lib/title-normalization.js') as {
  normalizeTitle: (t: string) => string;
};

// ─── Types ──────────────────────────────────────────────────────────────
interface KalshiSeries {
  ticker: string;
  title: string;
  category: string;
  frequency: string;
}
interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title?: string;
  sub_title?: string;
  category?: string;
  last_updated_ts?: string;
}
interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  status: string;
  result?: string;
  last_price?: number | null;
  yes_bid?: number | null;
  yes_ask?: number | null;
  close_time?: string;
  expected_expiration_time?: string;
}

interface ClosingPrice {
  showTitle: string;
  marketTicker: string;
  impliedProb: number | null;
  wonMarket: boolean;
  status: string;
}
interface RaceRecord {
  season: string;
  tonyCategory: string;
  kalshiSeriesTicker: string;
  kalshiEventTicker: string;
  kalshiCloseTime: string | null;
  closingPrices: ClosingPrice[];
  winnerShowTitle: string | null;
  winnerShowId: string | null;
  kalshiTopPick: string | null;
  kalshiTopPickProb: number | null;
  kalshiHit: boolean | null;
  notes?: string;
}
interface OutputFile {
  _meta: {
    generatedAt: string;
    source: string;
    endpointBase: string;
    seasonsCovered: string[];
    seriesProbed: string[];
    noData: boolean;
    findings: string;
  };
  races: RaceRecord[];
  diagnostics: {
    seriesProbed: Array<{
      ticker: string;
      title: string;
      eventCount: number;
      eventsWithMarkets: number;
      totalMarketsAcrossEvents: number;
      sampleEventTickers: string[];
    }>;
  };
}

const API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = 'Mozilla/5.0 (BroadwayScorecard/kalshi-tony-history scraper)';

// Tony-related series tickers we know of. KXTONYAWARDS is the canonical
// modern (2026+) bundle. The KXBEST* tickers are 2025 single-category
// placeholder series. Add to this list if Kalshi creates new ones (e.g.
// KXTONYAWARDS-27).
const KNOWN_TONY_SERIES = [
  'KXTONYAWARDS',
  'KXBESTMUSICAL',
  'KXBESTPLAY',
  'KXBESTREVIVAL',
  'KXBESTREVIVALMUS',
  'KXBESTACTORMUS',
  'KXBESTACTORTONYAWARDS',
  'KXBESTACRESSTONYS',
];

// ─── HTTP helpers ────────────────────────────────────────────────────────
const REQUEST_SPACING_MS = 350; // Kalshi public API tolerates ~3 req/s
let lastRequestAt = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson<T>(url: string): Promise<T> {
  // Throttle: ensure at least REQUEST_SPACING_MS between requests.
  const wait = REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);

  // Retry on 429 with exponential backoff (max 4 tries, 16s total).
  for (let attempt = 0; attempt < 4; attempt += 1) {
    lastRequestAt = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429) {
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
      console.warn(`[kalshi-tony-history] 429 from ${url}; backoff ${backoff}ms (attempt ${attempt + 1}/4)`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`HTTP 429 exhausted retries for ${url}`);
}

async function paginate<T>(
  baseUrl: string,
  key: 'events' | 'markets' | 'series'
): Promise<T[]> {
  const out: T[] = [];
  let cursor = '';
  let pages = 0;
  while (pages < 25) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = cursor ? `${baseUrl}${sep}cursor=${encodeURIComponent(cursor)}` : baseUrl;
    const j = (await getJson(url)) as Record<string, unknown>;
    const arr = (j[key] as T[]) ?? [];
    out.push(...arr);
    cursor = (j.cursor as string) ?? '';
    if (!cursor || arr.length === 0) break;
    pages += 1;
  }
  return out;
}

// ─── Awards.json cross-reference ────────────────────────────────────────
interface AwardsShows {
  [showId: string]: {
    tony?: { season?: string; wins?: string[] };
  };
}
function loadAwardsShows(): AwardsShows {
  const p = path.join(__dirname, '..', 'data', 'awards.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { shows: AwardsShows };
  return j.shows || {};
}

function findShowIdForWinner(
  winnerTitle: string,
  season: string,
  tonyCategory: string,
  awards: AwardsShows
): string | null {
  const targetNorm = normalizeTitle(winnerTitle);
  // Some categories are person-not-show (e.g. Best Actor). For those we
  // wouldn't expect an awards.json show match; return null so the caller can
  // decide whether to populate winnerShowTitle alone.
  const isShowLevelCategory = /best (musical|play|revival)/i.test(tonyCategory);
  if (!isShowLevelCategory) return null;

  // First pass: exact title match within season
  for (const [id, entry] of Object.entries(awards)) {
    if (!entry.tony) continue;
    if (entry.tony.season && season && entry.tony.season !== season) continue;
    // We can't read entry.title directly (it's not stored on awards entries);
    // fall back to ID slug normalization.
    const idTitle = id.replace(/-\d{4}$/, '').replace(/-/g, ' ');
    if (normalizeTitle(idTitle) === targetNorm) {
      if (entry.tony.wins?.some((w) => normalizeTitle(w) === normalizeTitle(tonyCategory))) {
        return id;
      }
      return id; // fallback: ID matches even if specific win not recorded
    }
  }
  // Second pass: id-slug contains-match within season
  for (const [id, entry] of Object.entries(awards)) {
    if (!entry.tony) continue;
    if (entry.tony.season && season && entry.tony.season !== season) continue;
    const idTitle = id.replace(/-\d{4}$/, '').replace(/-/g, ' ');
    const idNorm = normalizeTitle(idTitle);
    if (idNorm.length >= 4 && (idNorm.includes(targetNorm) || targetNorm.includes(idNorm))) {
      return id;
    }
  }
  return null;
}

// ─── Mapping helpers ────────────────────────────────────────────────────
/**
 * KXTONYAWARDS event tickers are like KXTONYAWARDS-26BM (year=26, suffix=BM).
 * Map to (season, tonyCategory).
 */
const KXTONYAWARDS_CATEGORY_MAP: Record<string, string> = {
  BM: 'Best Musical',
  BP: 'Best Play',
  BROAM: 'Best Revival of a Musical',
  BROAP: 'Best Revival of a Play',
  BACT: 'Best Performance by an Actor in a Leading Role in a Musical',
  BACTR: 'Best Performance by an Actress in a Leading Role in a Musical',
  BPBAA: 'Best Performance by an Actor in a Leading Role in a Play',
  BPBAAC: 'Best Performance by an Actress in a Leading Role in a Play',
  BACTFP: 'Best Performance by an Actor in a Featured Role in a Play',
  BACTRFP: 'Best Performance by an Actress in a Featured Role in a Play',
  BPACTFRM: 'Best Performance by an Actor in a Featured Role in a Musical',
  BPACTRFRM: 'Best Performance by an Actress in a Featured Role in a Musical',
  BDOAM: 'Best Direction of a Musical',
  BDOAP: 'Best Direction of a Play',
  BC: 'Best Choreography',
  BBOAM: 'Best Book of a Musical',
  BOS: 'Best Original Score',
  BO: 'Best Orchestrations',
  BSDOAM: 'Best Scenic Design of a Musical',
  BSDOAP: 'Best Scenic Design of a Play',
  BCDOAM: 'Best Costume Design of a Musical',
  BCDOAP: 'Best Costume Design of a Play',
  BLDOAP: 'Best Lighting Design of a Play',
  BSCDOAM: 'Best Sound Design of a Musical',
  BSODOAP: 'Best Sound Design of a Play',
};

function parseKxtonyEvent(eventTicker: string): { season: string; tonyCategory: string } {
  // e.g. KXTONYAWARDS-26BM → year 2026 (season 2025-26), suffix BM
  const m = eventTicker.match(/^KXTONYAWARDS-(\d{2})([A-Z]+)$/);
  if (!m) return { season: 'unknown', tonyCategory: eventTicker };
  const yy = Number(m[1]);
  const fullYear = 2000 + yy;
  const season = `${fullYear - 1}-${String(fullYear).slice(2)}`;
  const suffix = m[2];
  const tonyCategory = KXTONYAWARDS_CATEGORY_MAP[suffix] || `Unknown (${suffix})`;
  return { season, tonyCategory };
}

function parseLegacyEvent(
  series: KalshiSeries,
  event: KalshiEvent
): { season: string; tonyCategory: string } {
  // Legacy: e.g. KXBESTMUSICAL-25 → season 2024-25, category from series.title.
  const m = event.event_ticker.match(/-(\d{2})$/);
  let season = 'unknown';
  if (m) {
    const yy = Number(m[1]);
    const fullYear = 2000 + yy;
    season = `${fullYear - 1}-${String(fullYear).slice(2)}`;
  }
  return { season, tonyCategory: series.title || event.title || event.event_ticker };
}

// ─── Main scraper ───────────────────────────────────────────────────────
async function fetchEventsForSeries(seriesTicker: string): Promise<KalshiEvent[]> {
  return paginate<KalshiEvent>(
    `${API_BASE}/events?series_ticker=${seriesTicker}&limit=200`,
    'events'
  );
}

async function fetchMarketsForEvent(eventTicker: string): Promise<KalshiMarket[]> {
  return paginate<KalshiMarket>(
    `${API_BASE}/markets?event_ticker=${eventTicker}&limit=200`,
    'markets'
  );
}

/**
 * Normalize a Kalshi market's last_price into an implied probability [0, 1].
 * Kalshi quotes prices in cents (0–100). When last_price is null (no trades),
 * fall back to (yes_bid + yes_ask) / 2 if both are present.
 */
function impliedProb(m: KalshiMarket): number | null {
  if (typeof m.last_price === 'number' && Number.isFinite(m.last_price)) {
    return m.last_price / 100;
  }
  if (
    typeof m.yes_bid === 'number' && Number.isFinite(m.yes_bid) &&
    typeof m.yes_ask === 'number' && Number.isFinite(m.yes_ask)
  ) {
    return (m.yes_bid + m.yes_ask) / 200;
  }
  return null;
}

function showTitleFromMarket(m: KalshiMarket): string {
  return (m.yes_sub_title || m.title || m.ticker).trim();
}

async function buildRaceFromEvent(
  series: KalshiSeries,
  event: KalshiEvent,
  awards: AwardsShows
): Promise<RaceRecord | null> {
  const markets = await fetchMarketsForEvent(event.event_ticker);
  if (markets.length === 0) return null;

  const { season, tonyCategory } =
    series.ticker === 'KXTONYAWARDS'
      ? parseKxtonyEvent(event.event_ticker)
      : parseLegacyEvent(series, event);

  const closingPrices: ClosingPrice[] = markets
    .filter((m) => !/^.+-TIE$/i.test(m.ticker)) // skip "Tie" markets in summary
    .map((m) => ({
      showTitle: showTitleFromMarket(m),
      marketTicker: m.ticker,
      impliedProb: impliedProb(m),
      wonMarket: (m.result || '').toLowerCase() === 'yes',
      status: m.status,
    }));

  const winner = closingPrices.find((p) => p.wonMarket);
  const winnerShowTitle = winner ? winner.showTitle : null;

  // Top pick = highest impliedProb among non-tie markets with non-null prob.
  const sorted = [...closingPrices]
    .filter((p) => p.impliedProb !== null)
    .sort((a, b) => (b.impliedProb! - a.impliedProb!));
  const top = sorted[0] || null;

  let winnerShowId: string | null = null;
  if (winnerShowTitle) {
    winnerShowId = findShowIdForWinner(winnerShowTitle, season, tonyCategory, awards);
  }

  return {
    season,
    tonyCategory,
    kalshiSeriesTicker: series.ticker,
    kalshiEventTicker: event.event_ticker,
    kalshiCloseTime: markets[0]?.close_time || null,
    closingPrices,
    winnerShowTitle,
    winnerShowId,
    kalshiTopPick: top ? top.showTitle : null,
    kalshiTopPickProb: top ? top.impliedProb : null,
    kalshiHit: winnerShowTitle && top ? top.showTitle === winnerShowTitle : null,
    notes: closingPrices.every((p) => p.impliedProb === null)
      ? 'all markets have null prices (no trades yet)'
      : undefined,
  };
}

async function main(): Promise<void> {
  console.log('[kalshi-tony-history] Probing series:', KNOWN_TONY_SERIES.join(', '));
  const awards = loadAwardsShows();

  const diagnostics: OutputFile['diagnostics']['seriesProbed'] = [];
  const races: RaceRecord[] = [];
  const seasonsCovered = new Set<string>();

  for (const ticker of KNOWN_TONY_SERIES) {
    let events: KalshiEvent[] = [];
    let seriesTitle = ticker;
    try {
      events = await fetchEventsForSeries(ticker);
    } catch (e) {
      console.warn(`[kalshi-tony-history] ${ticker}: events fetch failed:`, (e as Error).message);
    }
    if (events[0]) seriesTitle = events[0].title || ticker;

    let eventsWithMarkets = 0;
    let totalMarkets = 0;
    const series: KalshiSeries = {
      ticker,
      title: seriesTitle,
      category: 'Entertainment',
      frequency: 'annual',
    };

    for (const ev of events) {
      const race = await buildRaceFromEvent(series, ev, awards);
      if (race && race.closingPrices.length > 0) {
        eventsWithMarkets += 1;
        totalMarkets += race.closingPrices.length;
        seasonsCovered.add(race.season);
        races.push(race);
      }
    }

    diagnostics.push({
      ticker,
      title: seriesTitle,
      eventCount: events.length,
      eventsWithMarkets,
      totalMarketsAcrossEvents: totalMarkets,
      sampleEventTickers: events.slice(0, 5).map((e) => e.event_ticker),
    });

    console.log(
      `[kalshi-tony-history]   ${ticker}: ${events.length} events, ` +
        `${eventsWithMarkets} with markets, ${totalMarkets} total markets`
    );
  }

  // A "historical" race is one whose markets are settled (status=settled OR
  // any market has result !== ''). Active-only snapshots aren't historical
  // odds — flag them in notes but exclude from the historical count.
  const settledRaces = races.filter((r) =>
    r.closingPrices.some((p) => p.status === 'settled' || p.wonMarket)
  );
  const hasSettledHistory = settledRaces.length > 0;

  const output: OutputFile = {
    _meta: {
      generatedAt: new Date().toISOString(),
      source: 'kalshi-api',
      endpointBase: API_BASE,
      seasonsCovered: Array.from(seasonsCovered).sort(),
      seriesProbed: KNOWN_TONY_SERIES,
      noData: !hasSettledHistory,
      findings: hasSettledHistory
        ? `Found ${settledRaces.length} settled Tony races across ${seasonsCovered.size} seasons.`
        : 'Kalshi has no settled Tony Awards markets. KXTONYAWARDS currently lists only 2026 active markets; legacy single-category tickers (KXBESTMUSICAL, KXBESTPLAY, etc.) have placeholder 2025 events with zero markets attached.',
    },
    races,
    diagnostics: { seriesProbed: diagnostics },
  };

  const outDir = path.join(__dirname, '..', 'data', 'analysis');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'kalshi-tony-historical-odds.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('\n[kalshi-tony-history] Wrote', outPath);
  console.log('[kalshi-tony-history] noData:', output._meta.noData);
  console.log('[kalshi-tony-history] races collected:', races.length);
  console.log('[kalshi-tony-history] settled races:', settledRaces.length);
  console.log('[kalshi-tony-history] seasons covered:', output._meta.seasonsCovered);

  // Per-category hit rate (only meaningful for settled races)
  if (settledRaces.length > 0) {
    const byCat = new Map<string, { total: number; hits: number }>();
    for (const r of settledRaces) {
      if (r.kalshiHit === null) continue;
      const c = byCat.get(r.tonyCategory) || { total: 0, hits: 0 };
      c.total += 1;
      if (r.kalshiHit) c.hits += 1;
      byCat.set(r.tonyCategory, c);
    }
    console.log('\n[kalshi-tony-history] Kalshi top-pick hit rate by category:');
    for (const [cat, { total, hits }] of Array.from(byCat.entries())) {
      const pct = total ? ((hits / total) * 100).toFixed(1) : 'n/a';
      console.log(`  ${cat.padEnd(60)} ${hits}/${total}  ${pct}%`);
    }
  } else {
    console.log(
      '\n[kalshi-tony-history] No settled history → no hit-rate summary. ' +
        'Output file flagged noData:true.'
    );
  }
}

main().catch((e) => {
  console.error('[kalshi-tony-history] FATAL:', e);
  process.exit(1);
});
