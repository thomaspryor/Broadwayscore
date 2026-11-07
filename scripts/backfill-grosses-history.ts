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
 * --refill-gaps re-fetches the stored weeks that miss a show held the weeks
 * either side (a week scraped short) and adds only the rows they lack; it
 * never changes a stored row (BRO-5016).
 *
 * --recheck-totals re-fetches every week whose rows miss the saved League
 * total (integrity rules total-mismatch / total-matches-prev-week) and settles
 * it with reconcilePublishedTotal against the page's own table: rows that
 * meet the table keep it (a printed total the table misses is set aside);
 * rows that miss it are replaced when every page row matched a show
 * (BRO-5038).
 *
 * Usage: npx tsx scripts/backfill-grosses-history.ts [--weeks 55] [--start-from 2025-01-19] [--refill-gaps] [--recheck-totals] [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';

// Use shared show-matching library (260+ aliases, market filtering, era preference)
const { matchTitleToShow } = require('./lib/show-matching');
const { repairGrossesHistory } = require('./lib/grosses-history-repair');
const { recordPublishedTotal, reconcilePublishedTotal, checkWeekTotals, sundayOf } = require('./lib/grosses-integrity');
const { historicalGrossesProduction } = require('./lib/grosses-run-window');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');
const {
  playbillGrossesUrl,
  parsePlaybillGrossesHtml,
  validatePlaybillGrosses,
  weekTotalMismatch,
  isPlausibleRow,
  toHistoryEntry,
  historyHasWeek,
  findShortHistoryWeeks,
  findUnstoredRunWeeks,
  addMissingRows,
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
  return historicalGrossesProduction(title, result, weekDateStr, allShows)?.slug ?? null;
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
    // Weeks end on Sunday and this walks backward, so start at the Sunday on
    // or before --start-from (a later Sunday may not be published yet).
    current = new Date(startFrom + 'T00:00:00Z');
    current.setUTCDate(current.getUTCDate() - current.getUTCDay());
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
async function scrapeWeek(weekDate: string): Promise<{ snapshot: Record<string, HistoryEntry>; matched: number; rows: number; weekTotalGross: number | null; tableGross: number }> {
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
  const tableGross = parsed.rows.reduce((sum: number, row: { gross: number | null }) => sum + (row.gross || 0), 0);
  return { snapshot, matched, rows: parsed.rows.length, weekTotalGross: parsed.weekTotalGross ?? null, tableGross };
}

async function backfillHistory(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  let numWeeks = 55; // Default: ~1 year of data
  let startFrom: string | undefined;
  const dryRun = args.includes('--dry-run');
  const refillGaps = args.includes('--refill-gaps');
  const recheckTotals = args.includes('--recheck-totals');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--weeks' && args[i + 1]) {
      numWeeks = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--start-from' && args[i + 1]) {
      startFrom = args[i + 1];
      i++;
    }
  }

  loadShows();
  const history = loadHistory();
  const historyKeys = Object.keys(history.weeks);
  let weeksToDo: string[];
  // Refill mode: the shows each stored week is missing, by week key.
  const holeSlugs = new Map<string, string[]>();
  if (recheckTotals) {
    // Gross findings only: a week merely short a show is --refill-gaps' job.
    // Fetched by Sunday; reconcile finds a BWW-era Monday key itself.
    const findings: Array<{ rule: string; week: string; measure?: string }> = checkWeekTotals(history);
    weeksToDo = [...new Set(findings.filter(f => f.measure === 'gross' && history.weeks[f.week]).map(f => sundayOf(f.week)))].sort();
    console.log(`Rechecking ${weeksToDo.length} stored weeks whose rows miss the saved League total...${dryRun ? ' (DRY RUN)' : ''}`);
  } else if (refillGaps) {
    const short = findShortHistoryWeeks(history);
    const unstored = findUnstoredRunWeeks(history, allShows);
    for (const { week, slugs } of [...short, ...unstored]) holeSlugs.set(week, [...new Set([...(holeSlugs.get(week) || []), ...slugs])]);
    weeksToDo = [...holeSlugs.keys()].sort();
    console.log(`Refilling ${weeksToDo.length} stored weeks: ${short.length} miss a show held the weeks either side, ${unstored.length} fall in a run with no stored row...${dryRun ? ' (DRY RUN)' : ''}`);
  } else {
    console.log(`Backfilling ${numWeeks} weeks of grosses history from Playbill...${dryRun ? ' (DRY RUN)' : ''}`);
    const weekDates = getWeekDates(numWeeks, startFrom);
    // Filter out weeks we already have, including under a nearby key (the
    // BWW-era Monday keys) so a Sunday duplicate is never written beside one.
    weeksToDo = weekDates.filter(d => !historyHasWeek(historyKeys, d));
    console.log(`${weekDates.length} total weeks, ${weeksToDo.length} need backfill (${weekDates.length - weeksToDo.length} already in history)`);
  }

  if (weeksToDo.length === 0) {
    console.log('Nothing to backfill!');
    return;
  }

  const save = () => {
    if (dryRun) return;
    repairGrossesHistory(history, { shows: allShows });
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
        const { snapshot, matched, rows, weekTotalGross, tableGross } = await scrapeWeek(weekDate);
        if (recheckTotals) {
          const { action, before, after, dropped } = reconcilePublishedTotal(history, weekDate, {
            snapshot, rowCount: rows, printedGross: weekTotalGross, tableGross, source: 'playbill',
          });
          const droppedNote = dropped?.length ? `, dropped ${dropped.join(', ')}` : '';
          const detail = action === 'rows-replaced' ? ` (rows $${before} -> $${after}${droppedNote})` : action === 'unresolved' ? ` (${matched}/${rows} rows matched a show)` : '';
          console.log(`  ✓ ${weekDate}: ${action}; page total $${weekTotalGross}, page table $${tableGross}, stored rows $${before}${detail}`);
          if (action === 'unresolved') {
            console.warn(`::warning::backfill-grosses-history: week ${weekDate}: stored rows miss the Playbill table but not every page row matched a show; left as stored.`);
            failCount++;
          } else successCount++;
          succeeded = true;
          if (successCount % 3 === 0) save();
        } else if (matched > 0 && refillGaps) {
          // weekDate is a stored key here, so the rows land beside the ones it holds.
          const weekRows = history.weeks[weekDate];
          const wanted = holeSlugs.get(weekDate) || [];
          const after = Object.keys(weekRows).length + wanted.filter(slug => snapshot[slug] && !weekRows[slug]).length;
          if (after > rows) {
            // A refetch would give the same answer: refuse the week, no retry.
            console.warn(`::warning::backfill-grosses-history: week ${weekDate} would hold ${after} rows but Playbill lists ${rows}; left as stored.`);
            failCount++;
            attempt = MAX_RETRIES;
            continue;
          }
          const added: string[] = addMissingRows(weekRows, snapshot, wanted);
          // Only a week that now holds every published row gets the League
          // total recorded; a short one would trip checkWeekTotals forever.
          if (Object.keys(weekRows).length === rows) {
            recordPublishedTotal(history, weekDate, { gross: weekTotalGross, showCount: rows, source: 'playbill', tableGross });
          }
          console.log(`  ✓ ${weekDate}: added ${added.length}/${wanted.length} missing rows${added.length ? ` (${added.join(', ')})` : ''}`);
          successCount++;
          succeeded = true;
          if (successCount % 3 === 0) save();
        } else if (matched > 0) {
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
