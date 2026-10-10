/**
 * Backfill Grosses History from Playbill
 *
 * Scrapes playbill.com/grosses for past weeks to populate grosses-history.json
 * with enough data for YoY comparisons (capacity YoY, ATP WoW/YoY).
 *
 * Fetches through fetchPage() and parses with the same pure parser the weekly
 * scraper uses (scripts/lib/parse-playbill-grosses.js, BRO-4623), so a
 * backfilled week has exactly the field semantics of a weekly-scraped one:
 * gross rounded to whole dollars, performances = Perfs + Previews, and
 * seatsOffered only when it reproduces the published % Cap. (The Playwright
 * table reader this replaced stored gross with cents and Perfs without
 * previews, i.e. 0 for every week a show was in previews.) Recent gaps (the
 * last 8 weeks) are filled by scrape-grosses.ts on its own; this script is for
 * initial setup or extending the history range.
 *
 * Usage: npx tsx scripts/backfill-grosses-history.ts [--weeks 55] [--start-from 2025-01-19] [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';

// Use shared show-matching library (260+ aliases, market filtering, era preference)
const { matchTitleToShow } = require('./lib/show-matching');
const { weekKeyFor, repairGrossesHistory } = require('./lib/grosses-history-repair');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');
const {
  playbillGrossesUrl,
  parsePlaybillGrossesHtml,
  validatePlaybillGrosses,
  weekTotalMismatch,
  isPlausibleRow,
  toHistoryEntry,
  historyHasWeek,
} = require('./lib/parse-playbill-grosses');

const HISTORY_PATH = path.join(__dirname, '../data/grosses-history.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');

interface HistoryEntry {
  gross: number | null;
  capacity: number | null;
  atp: number | null;
  attendance: number | null;
  // Seats in Theatre × (Perfs + Previews), only when that reproduces the
  // published % Cap (see parse-playbill-grosses.js). Optional because older
  // history rows were written without it.
  seatsOffered?: number | null;
  performances: number | null;
}

interface GrossesHistory {
  _meta: {
    description: string;
    lastUpdated: string;
  };
  weeks: Record<string, Record<string, HistoryEntry>>;
}

// Load shows array for shared matching library
let allShows: any[] = [];
function loadShows(): void {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  allShows = Array.isArray(data.shows) ? data.shows : Object.values(data.shows);
}

// Match a Playbill title to a show slug using the shared library
// Playbill only covers Broadway → market: 'broadway'. This is a HISTORICAL
// backfill, not a live-week scrape: pass the exact week date so the shared
// matcher disambiguates same-title productions (e.g. Cabaret 1998/2014, Gypsy
// 1989/2003/2024) by which one's run window actually contains that week
// (falls back to closest-opening-year if no window matches), instead of
// always picking whichever revival is open TODAY — otherwise every historical
// week for a recurring title gets attributed to whatever's running right now.
// Found 2026-07-20: year-only disambiguation caused 2,351 chronologically-
// impossible show/week entries across 250 shows in the 2001-2018 backfill.
function findMatchingSlug(title: string, weekDateStr: string): string | null {
  const weekYear = new Date(weekDateStr + 'T00:00:00Z').getFullYear();
  const result = matchTitleToShow(title, allShows, { market: 'broadway', prefer: 'open', year: weekYear, date: weekDateStr });
  if (!result?.show) return null;
  // Require high confidence — medium (word-based fuzzy) causes wrong-show contamination
  if (result.confidence !== 'high') return null;
  const show = result.show;
  // Double-check: reject WE/OB matches (safety net)
  if (show.id?.includes('west-end') || show.id?.includes('off-broadway') || show.id?.includes('off-west-end')) {
    return null;
  }
  return show.slug;
}

// Load or initialize grosses history
function loadHistory(): GrossesHistory {
  if (fs.existsSync(HISTORY_PATH)) {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  }
  return {
    _meta: {
      description: 'Weekly box office snapshots for computing WoW and YoY comparisons',
      lastUpdated: new Date().toISOString()
    },
    weeks: {}
  };
}

// Get list of week dates to backfill
function getWeekDates(numWeeks: number, startFrom?: string): string[] {
  const dates: string[] = [];
  let current: Date;

  if (startFrom) {
    // Weeks end on Sunday: a --start-from on any other day means its week.
    current = new Date(weekKeyFor(startFrom) + 'T00:00:00Z');
  } else {
    // Start from the most recent Sunday
    current = new Date();
    current.setUTCDate(current.getUTCDate() - current.getUTCDay());
  }

  for (let i = 0; i < numWeeks; i++) {
    const dateStr = current.toISOString().split('T')[0];
    dates.push(dateStr);
    current.setUTCDate(current.getUTCDate() - 7);
  }

  return dates;
}

// One week: fetch, integrity-check (schema, requested week actually shown),
// match. Throws on any problem so the caller's retry loop handles it. A row
// sum that misses the Week's Total is logged, not fatal: some old Playbill
// weeks print a total their own table does not add up to, and the rows are
// still the best record of that week (see validatePlaybillGrosses).
async function scrapeWeek(weekDate: string): Promise<{ snapshot: Record<string, HistoryEntry>; matched: number; rows: number }> {
  const url = playbillGrossesUrl(weekDate);
  const page = await fetchPage(url);
  const parsed = parsePlaybillGrossesHtml(page?.content || '');
  if (parsed.schemaError) {
    console.error(`::error::backfill-grosses-history: ${parsed.schemaError}`);
  }
  const problems: string[] = validatePlaybillGrosses(parsed, { expectedWeek: weekDate, allowTotalMismatch: true });
  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }
  const mismatch: string | null = weekTotalMismatch(parsed);
  if (mismatch) {
    console.warn(`::warning::backfill-grosses-history: ${url}: ${mismatch}; storing the rows as published.`);
  } else if (parsed.weekTotalGross == null) {
    console.warn(`::warning::backfill-grosses-history: ${url} has no "Week's Total"; the row-sum checksum was skipped.`);
  }

  const snapshot: Record<string, HistoryEntry> = {};
  let matched = 0;
  for (const row of parsed.rows) {
    if (!isPlausibleRow(row)) {
      console.warn(`  ⚠ Dropping "${row.show}" — implausible parsed values (atp=${row.atp}, perf=${row.performances}, cap=${row.capacityPct})`);
      continue;
    }
    const slug = findMatchingSlug(row.show, weekDate);
    if (!slug) continue;
    snapshot[slug] = toHistoryEntry(row);
    matched++;
  }
  return { snapshot, matched, rows: parsed.rows.length };
}

async function backfillHistory(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  let numWeeks = 55; // Default: ~1 year of data
  let startFrom: string | undefined;
  const dryRun = args.includes('--dry-run');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--weeks' && args[i + 1]) {
      numWeeks = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--start-from' && args[i + 1]) {
      startFrom = args[i + 1];
      i++;
    }
  }

  console.log(`Backfilling ${numWeeks} weeks of grosses history from Playbill...${dryRun ? ' (DRY RUN)' : ''}`);

  loadShows();
  const history = loadHistory();
  const weekDates = getWeekDates(numWeeks, startFrom);

  // Filter out weeks we already have, including under a nearby key (the
  // BWW-era Monday keys) so a Sunday duplicate is never written beside one.
  const historyKeys = Object.keys(history.weeks);
  const weeksToDo = weekDates.filter(d => !historyHasWeek(historyKeys, d));
  console.log(`${weekDates.length} total weeks, ${weeksToDo.length} need backfill (${weekDates.length - weeksToDo.length} already in history)`);

  if (weeksToDo.length === 0) {
    console.log('Nothing to backfill!');
    return;
  }

  const save = () => {
    if (dryRun) return;
    repairGrossesHistory(history);
    history._meta.lastUpdated = new Date().toISOString();
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
  };

  let successCount = 0;
  let failCount = 0;

  for (const weekDate of weeksToDo) {
    const MAX_RETRIES = 3;
    let succeeded = false;
    console.log(`\nFetching week ${weekDate}...`);

    for (let attempt = 1; attempt <= MAX_RETRIES && !succeeded; attempt++) {
      if (attempt > 1) console.log(`  Retry ${attempt}/${MAX_RETRIES} for week ${weekDate}...`);
      try {
        const { snapshot, matched, rows } = await scrapeWeek(weekDate);
        if (matched > 0) {
          history.weeks[weekDate] = snapshot;
          console.log(`  ✓ ${matched}/${rows} shows matched for week ${weekDate}`);
          successCount++;
          succeeded = true;
          // Save incrementally every 3 weeks
          if (successCount % 3 === 0) {
            save();
            console.log(`  [Saved progress: ${Object.keys(history.weeks).length} weeks]`);
          }
        } else {
          console.log(`  ⚠ No shows matched for week ${weekDate} (${rows} rows found)`);
          if (attempt === MAX_RETRIES) failCount++;
        }
      } catch (error: any) {
        console.warn(`  ⚠ Week ${weekDate} attempt ${attempt}: ${error.message}`);
        if (attempt === MAX_RETRIES) {
          console.error(`  ✗ Failed for week ${weekDate} after ${MAX_RETRIES} attempts`);
          failCount++;
        }
      }

      // Delay between requests (longer on retry)
      const delay = succeeded ? 2000 : (attempt < MAX_RETRIES ? 5000 : 2000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Final save
  save();

  console.log(`\n=== Backfill Complete ===`);
  console.log(`Success: ${successCount}, Failed: ${failCount}`);
  console.log(`Total weeks in history: ${Object.keys(history.weeks).length}`);
  console.log(dryRun ? '[DRY RUN] Nothing written.' : `Saved to ${HISTORY_PATH}`);
}

backfillHistory()
  .then(() => cleanupScraper())
  .catch(async (error) => {
    console.error('Fatal error:', error);
    try { await cleanupScraper(); } catch { /* exiting anyway */ }
    process.exit(1);
  });
