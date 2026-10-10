#!/usr/bin/env node
/**
 * West End Date Enrichment Script
 *
 * Enriches West End shows in shows.json with preview start dates and opening
 * (press night) dates from two sources:
 *   1. Theatremonkey.com (primary, ~80+ shows with structured Press Night dates)
 *   2. Playbill London schedule (secondary, ~15 shows, cross-validates)
 * and, since the 2026 data audit (S7-T10), backfills closingDate (source
 * 'olt') and ageRecommendation from Official London Theatre — the listing
 * JSON-LD discovery already fetches, plus each show page's age guidance —
 * on WE/OWE rows where the field is null. Existing values are never
 * overwritten; humanCorrectedClosingDate: true rows are never touched
 * (scripts/lib/olt-enrichment.js holds the decision, closingDate goes through
 * scripts/lib/closing-date-guard.js, the save through shows-write-guard.js).
 *
 * Usage:
 *   node scripts/enrich-west-end-dates.js [options]
 *
 * Options:
 *   --dry-run            Show what would change without modifying files
 *   --show=SLUG          Only process a specific show by slug
 *   --verify             Compare dates vs shows.json, report discrepancies (no writes)
 *   --force              Overwrite existing dates
 *   --fix-unconfirmed    Also process shows with unconfirmed openingDateSource
 *                        (todaytix, showscore, unknown) — used by daily cron
 *   --skip-olt           Skip the Official London Theatre backfill phase
 *   --olt-only           Run ONLY the OLT backfill (no Theatremonkey/Playbill)
 *   --olt-html=PATH      Read the OLT listing from a saved HTML file instead of
 *                        fetching it (offline dry-runs, fixtures)
 *   --olt-age-pages=N    Max OLT show pages to fetch for age guidance per run
 *                        (default 40; 0 disables the per-show fetches)
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { matchTitleToShow } = require('./lib/show-matching');
const { isUnconfirmedDateSource } = require('./lib/date-source-confidence');
const { inferPressNightFromReviews } = require('./lib/infer-press-night-from-reviews');
const showsWriteGuard = require('./lib/shows-write-guard');
const { writeClosingDate } = require('./lib/closing-date-guard');
const {
  OLT_LISTING_URL,
  isoDay,
  parseOltTheaterEvents,
  parseOltAgeGuidance,
  isOltEnrichable,
  planOltEnrichment,
} = require('./lib/olt-enrichment');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-west-end-dates.js — West End Date Enrichment Script.

Usage:
  node scripts/enrich-west-end-dates.js [options]
  node scripts/enrich-west-end-dates.js --help, -h    print this usage and exit
`;
// hygiene-help-flag-ok: audit-help-flag-safety.js's risky-call regex matches this file's own local saveShows(data) wrapper DECLARATION (`function saveShows(data) {`), not a call — the wrapper is only invoked from inside main(), well after the --help guard. Verified: node <this file> --help exits immediately with no fs/network side effects.
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const PLAYBILL_URL = 'https://playbill.com/article/schedule-of-upcoming-london-shows';
const TM_INDEX_URL = 'https://www.theatremonkey.com/shows/';
const TM_SHOW_URL = 'https://www.theatremonkey.com/show/';
const FETCH_DELAY_MS = 1500;
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)',
  'Accept': 'text/html'
};

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12'
};

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const force = args.includes('--force');
const fixUnconfirmed = args.includes('--fix-unconfirmed');
const missingOnly = !force && !fixUnconfirmed;

const showArg = args.find(a => a.startsWith('--show='));
const showSlug = showArg ? showArg.split('=')[1] : null;

// Official London Theatre backfill phase (audit S7-T10).
const skipOlt = args.includes('--skip-olt');
const oltOnly = args.includes('--olt-only');
const oltHtmlArg = args.find(a => a.startsWith('--olt-html='));
const oltHtmlPath = oltHtmlArg ? oltHtmlArg.split('=').slice(1).join('=') : null;
const oltAgePagesArg = args.find(a => a.startsWith('--olt-age-pages='));
const OLT_AGE_PAGES_DEFAULT = 40;
const oltAgePages = oltAgePagesArg
  ? Math.max(0, parseInt(oltAgePagesArg.split('=')[1], 10) || 0)
  : OLT_AGE_PAGES_DEFAULT;
const OLT_AGE_PAGE_DELAY_MS = 1500;
const FETCH_TIMEOUT_MS = 30000;

function loadShows() {
  return showsWriteGuard.loadShows();
}

function saveShows(data) {
  showsWriteGuard.saveShows(data);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(url) {
  // Plain HTTPS: Theatremonkey, Playbill and OLT all serve static HTML with
  // no bot wall (discovery fetches OLT the same way), so the scraping-service
  // chain is not needed. Bounded so a dead socket can't eat the cron run.
  const response = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.text();
}

/**
 * Clean title for better matching — strip common prefixes
 */
function cleanTitle(title) {
  return title
    .replace(/['']/g, "'")          // normalize smart quotes to ASCII
    .replace(/^Disney's\s+/i, '')
    .replace(/\s+the Musical$/i, '')
    .trim();
}

// ============================================================
// THEATREMONKEY PARSING
// ============================================================

/**
 * Parse British ordinal date: "28th May 2026" → "2026-05-28"
 */
function parseBritishDate(text) {
  const match = text.match(/(\d{1,2})(?:st|nd|rd|th)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!match) return null;

  const day = match[1].padStart(2, '0');
  const month = MONTHS[match[2].toLowerCase()];
  const year = match[3];

  const y = parseInt(year);
  if (y < 2024 || y > 2028) return null;

  return `${year}-${month}-${day}`;
}

/**
 * Parse Theatremonkey index page → [{title, tmSlug}]
 */
function parseTheatremonkeyIndex(html) {
  const $ = cheerio.load(html);
  const shows = [];
  const seen = new Set();

  $('a[href*="/show/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/show\/([^/]+)\/?$/);
    if (!match) return;

    const slug = match[1];
    if (slug === 'shows' || seen.has(slug)) return;

    const title = $(el).text().trim();
    // Skip non-title links (empty, "Read more...", "Show Details...")
    if (title.length < 2 || /^(Read more|Show Details|Reviews)/i.test(title)) return;

    seen.add(slug);
    shows.push({ title, tmSlug: slug });
  });

  return shows;
}

/**
 * Extract dates from a Theatremonkey show page
 */
function extractTheatremonkeyDates(html) {
  // "Showing from Wed, 20th May 2026 to Sat, 17th April 2027"
  const showingMatch = html.match(/Showing from\s+\w+,\s+(\d{1,2}(?:st|nd|rd|th)\s+\w+\s+\d{4})/i);
  const showingFrom = showingMatch ? parseBritishDate(showingMatch[1]) : null;

  // "Press Night: 28th May 2026" (may have trailing period or whitespace)
  const pressMatch = html.match(/Press Night:\s*(\d{1,2}(?:st|nd|rd|th)\s+\w+\s+\d{4})/i);
  const pressNight = pressMatch ? parseBritishDate(pressMatch[1]) : null;

  return { showingFrom, pressNight };
}

/**
 * Scrape Theatremonkey: index → match to our shows → fetch matched pages
 */
/**
 * Generate TM slug candidates from a show title.
 * TM slugs are lowercase, hyphenated, no special chars.
 */
function titleToTmSlugs(show) {
  const title = (show.title || '').toLowerCase().trim();
  const base = title
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const slugs = [base];

  // Try with "the-" prefix stripped/added
  if (base.startsWith('the-')) {
    slugs.push(base.slice(4));
  } else {
    slugs.push('the-' + base);
  }

  // Try with venue appended (TM sometimes uses "show-venue" slugs)
  if (show.venue) {
    const venueSlug = show.venue.toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-');
    slugs.push(base + '-' + venueSlug);
  }

  return [...new Set(slugs)];
}

async function scrapeTheatremonkey(weShows) {
  console.log('--- THEATREMONKEY ---');
  console.log(`Fetching index: ${TM_INDEX_URL}`);

  const indexHtml = await fetchPage(TM_INDEX_URL);
  if (!indexHtml) {
    console.warn('WARNING: Failed to fetch Theatremonkey index');
    return [];
  }

  const indexEntries = parseTheatremonkeyIndex(indexHtml);
  console.log(`Found ${indexEntries.length} shows on Theatremonkey index`);
  if (indexHtml.length > 10000 && indexEntries.length === 0) {
    console.error('⚠️  WARNING: Theatremonkey page loaded but 0 shows parsed — HTML structure may have changed');
  }

  // Match titles to our shows FIRST, then only fetch matched pages
  const matched = [];
  for (const entry of indexEntries) {
    const cleaned = cleanTitle(entry.title);
    const result = matchTitleToShow(cleaned, weShows, { market: 'west-end' });
    if (result && result.confidence === 'high' && (result.show.category === 'west-end' || result.show.category === 'off-west-end')) {
      matched.push({ ...entry, show: result.show, confidence: result.confidence });
    }
  }
  console.log(`Matched ${matched.length} to our WE shows (skipping ${indexEntries.length - matched.length} unmatched)`);

  // When --show is used and index matching found nothing, try direct page fetch.
  // TM index only lists ~88 current shows; many valid pages exist outside the index.
  // Extract dates inline to avoid redundant re-fetch in the main loop.
  const directEntries = [];
  if (showSlug && matched.length === 0 && weShows.length <= 3) {
    console.log('  No index match — trying direct TM page fetch...');
    for (const show of weShows) {
      const slugCandidates = titleToTmSlugs(show);
      let found = false;
      for (const slug of slugCandidates) {
        const url = `${TM_SHOW_URL}${slug}/`;
        const html = await fetchPage(url);
        if (html && !html.includes('page-not-found')) {
          const dates = extractTheatremonkeyDates(html);
          if (dates.showingFrom || dates.pressNight) {
            directEntries.push({
              title: show.title,
              firstPreview: dates.showingFrom,
              opening: dates.pressNight,
              source: 'theatremonkey'
            });
            console.log(`  Direct hit: ${show.title} → ${slug} | Preview: ${dates.showingFrom || '—'} | Press Night: ${dates.pressNight || '—'}`);
            found = true;
            break;
          }
        }
        await sleep(500);
      }
      if (!found) {
        console.log(`  No TM page found for ${show.title}`);
      }
    }
  }

  console.log('');

  // Fetch each index-matched show page
  const entries = [...directEntries];
  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    if (i > 0) await sleep(FETCH_DELAY_MS);

    const url = `${TM_SHOW_URL}${m.tmSlug}/`;
    const html = await fetchPage(url);
    if (!html) {
      console.log(`  [${i + 1}/${matched.length}] ${m.title} — 404/error, skipping`);
      continue;
    }

    const dates = extractTheatremonkeyDates(html);
    if (dates.showingFrom || dates.pressNight) {
      entries.push({
        title: m.title,
        firstPreview: dates.showingFrom,
        opening: dates.pressNight,
        source: 'theatremonkey'
      });
      console.log(`  [${i + 1}/${matched.length}] ${m.title} | Preview: ${dates.showingFrom || '—'} | Press Night: ${dates.pressNight || '—'}`);
    } else {
      console.log(`  [${i + 1}/${matched.length}] ${m.title} — no dates found`);
    }
  }

  console.log(`\nTheatremonkey: ${entries.length} shows with date data`);
  return entries;
}

// ============================================================
// PLAYBILL PARSING (existing logic)
// ============================================================

/**
 * Parse "Month Day, Year" into YYYY-MM-DD
 */
function parsePlaybillDate(text) {
  const match = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!match) return null;

  const month = MONTHS[match[1].toLowerCase()];
  const day = match[2].padStart(2, '0');
  const year = match[3];

  const y = parseInt(year);
  if (y < 2024 || y > 2028) return null;

  return `${year}-${month}-${day}`;
}

function parsePlaybillSchedulePage(html) {
  const $ = cheerio.load(html);
  const entries = [];
  let currentEntry = null;

  const articleBody = $('[class*="article"] p, [class*="article"] ul, [class*="article"] strong, [class*="article"] b, [class*="article"] h2, [class*="article"] h3').toArray();
  const elements = articleBody.length > 0 ? articleBody : $('p, ul, strong, b, h2, h3').toArray();

  for (const el of elements) {
    const tagName = el.tagName?.toLowerCase();

    if (tagName === 'strong' || tagName === 'b' || tagName === 'h2' || tagName === 'h3') {
      const text = $(el).text().trim();
      if (text.length >= 3 &&
          !text.match(/^(Theatre|Theater|First Preview|Opening|Opens|Book|Music|Lyrics|Director|Playwright|Cast|Starring|Written|Choreograph)/i) &&
          !text.includes(':')) {
        if (currentEntry) entries.push(currentEntry);
        currentEntry = { title: text, firstPreview: null, opening: null, theatre: null };
      }
    }

    if (tagName === 'ul' && currentEntry) {
      $(el).find('li').each((_, li) => {
        const text = $(li).text().trim();
        if (/^First Preview/i.test(text)) {
          currentEntry.firstPreview = parsePlaybillDate(text);
        } else if (/^Open(?:s|ing)/i.test(text)) {
          currentEntry.opening = parsePlaybillDate(text);
        } else if (/^Theat(?:re|er)/i.test(text)) {
          currentEntry.theatre = text.replace(/^Theat(?:re|er):\s*/i, '').trim();
        }
      });
    }

    if (tagName === 'p' && currentEntry) {
      const text = $(el).text().trim();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (/^First Preview/i.test(line)) {
          currentEntry.firstPreview = parsePlaybillDate(line);
        } else if (/^Open(?:s|ing)/i.test(line)) {
          currentEntry.opening = parsePlaybillDate(line);
        } else if (/^Theat(?:re|er)/i.test(line)) {
          currentEntry.theatre = line.replace(/^Theat(?:re|er):\s*/i, '').trim();
        }
      }
    }
  }

  if (currentEntry) entries.push(currentEntry);
  return entries;
}

async function scrapePlaybill() {
  console.log('');
  console.log('--- PLAYBILL ---');
  console.log(`Fetching: ${PLAYBILL_URL}`);

  try {
    const html = await fetchPage(PLAYBILL_URL);
    if (!html) {
      console.warn('WARNING: Failed to fetch Playbill page');
      return [];
    }
    console.log(`Fetched ${(html.length / 1024).toFixed(1)} KB`);

    const entries = parsePlaybillSchedulePage(html);
    console.log(`Parsed ${entries.length} show entries from Playbill`);
    for (const e of entries) {
      console.log(`  ${e.title} | Preview: ${e.firstPreview || '—'} | Opening: ${e.opening || '—'}`);
    }
    return entries.map(e => ({ ...e, source: 'playbill' }));
  } catch (err) {
    console.warn(`WARNING: Playbill fetch error: ${err.message}`);
    return [];
  }
}

// ============================================================
// SOURCE MERGING
// ============================================================

function mergeSources(tmEntries, pbEntries) {
  const merged = new Map();

  // Theatremonkey first (primary)
  for (const entry of tmEntries) {
    merged.set(entry.title.toLowerCase(), {
      title: entry.title,
      firstPreview: entry.firstPreview,
      opening: entry.opening,
      source: 'theatremonkey'
    });
  }

  // Playbill second (fills gaps, cross-validates)
  for (const entry of pbEntries) {
    const key = entry.title.toLowerCase();
    if (merged.has(key)) {
      const existing = merged.get(key);
      // Cross-validate
      if (entry.firstPreview && existing.firstPreview && entry.firstPreview !== existing.firstPreview) {
        console.log(`  CROSS-CHECK ${entry.title}: preview TM=${existing.firstPreview} PB=${entry.firstPreview}`);
      }
      if (entry.opening && existing.opening && entry.opening !== existing.opening) {
        console.log(`  CROSS-CHECK ${entry.title}: opening TM=${existing.opening} PB=${entry.opening}`);
      }
      // Fill gaps from Playbill
      if (!existing.firstPreview && entry.firstPreview) existing.firstPreview = entry.firstPreview;
      if (!existing.opening && entry.opening) existing.opening = entry.opening;
      existing.source = 'both';
    } else {
      // Playbill-only show
      merged.set(key, {
        title: entry.title,
        firstPreview: entry.firstPreview,
        opening: entry.opening,
        source: 'playbill'
      });
    }
  }

  return [...merged.values()];
}

// ============================================================
// OFFICIAL LONDON THEATRE — closingDate + ageRecommendation backfill (S7-T10)
// ============================================================

/**
 * Match every OLT listing entry to a WE/OWE row and plan the backfill.
 * Network: one listing fetch (or --olt-html=PATH), plus at most
 * --olt-age-pages show-page fetches for rows still missing ageRecommendation
 * (the age guidance is on the show page, not in the listing JSON-LD).
 * Every decision is the pure planOltEnrichment() in
 * scripts/lib/olt-enrichment.js; this function only fetches, matches, logs.
 *
 * @returns {{changes: Array, matched: number, unmatched: string[], skipped: number,
 *            agePagesFetched: number, events: number}}
 */
async function scrapeOfficialLondonTheatre(weShows) {
  console.log('');
  console.log('--- OFFICIAL LONDON THEATRE (closingDate + age backfill) ---');
  const result = { changes: [], matched: 0, unmatched: [], skipped: 0, agePagesFetched: 0, events: 0 };

  let html = null;
  if (oltHtmlPath) {
    console.log(`Reading cached listing: ${oltHtmlPath}`);
    html = fs.readFileSync(oltHtmlPath, 'utf8');
  } else {
    console.log(`Fetching: ${OLT_LISTING_URL}`);
    try {
      html = await fetchPage(OLT_LISTING_URL);
    } catch (err) {
      console.warn(`WARNING: OLT fetch error: ${err.message}`);
    }
  }
  if (!html || html.length < 3000) {
    console.warn(`WARNING: OLT listing unavailable or suspiciously short (${html ? html.length : 0} bytes) — skipping backfill`);
    return result;
  }

  const events = parseOltTheaterEvents(html);
  result.events = events.length;
  console.log(`Parsed ${events.length} TheaterEvent entries`);
  if (events.length < 5) {
    console.warn('WARNING: fewer than 5 OLT entries — possible partial fetch, skipping backfill');
    return result;
  }

  // One entry per row (first wins — OLT can list a title twice for a return
  // engagement). High-confidence title matches only, same bar as Theatremonkey.
  // `date` (the OLT run start) lets matchTitleToShow pick, among same-title
  // productions, the one whose run window contains it (the-cherry-orchard-
  // west-end-2026 vs the-cherry-orchard-riverside-studios-off-west-end-2026);
  // it falls back to the usual most-recent pick when no window matches.
  const byShowId = new Map();
  for (const event of events) {
    const runStart = isoDay(event.startDate);
    const match = matchTitleToShow(cleanTitle(event.title), weShows, { market: 'west-end', ...(runStart ? { date: runStart } : {}) });
    if (!match || match.confidence !== 'high' || (match.show.category !== 'west-end' && match.show.category !== 'off-west-end')) {
      result.unmatched.push(event.title);
      continue;
    }
    if (!byShowId.has(match.show.id)) byShowId.set(match.show.id, { show: match.show, event });
  }
  result.matched = byShowId.size;
  console.log(`Matched ${byShowId.size} entries to WE/OWE rows (${result.unmatched.length} unmatched)`);

  let agePagesLeft = oltAgePages;
  for (const { show, event } of byShowId.values()) {
    if (!isOltEnrichable(show)) {
      result.skipped++;
      console.log(`  SKIP ${show.title} (${show.id}): status=${show.status}${show.closingDate ? `, closed ${show.closingDate}` : ''} — not live or recently closed`);
      continue;
    }
    const wantsAge = !show.ageRecommendation && !!event.url;
    if (wantsAge && agePagesLeft > 0) {
      agePagesLeft--;
      try {
        if (result.agePagesFetched > 0) await sleep(OLT_AGE_PAGE_DELAY_MS);
        const pageHtml = await fetchPage(event.url);
        result.agePagesFetched++;
        event.ageRecommendation = pageHtml ? parseOltAgeGuidance(pageHtml) : null;
        console.log(`  age page ${event.url} → ${event.ageRecommendation || (pageHtml ? 'no guidance on page' : 'fetch returned nothing')}`);
      } catch (err) {
        console.log(`  age page fetch failed for ${show.title}: ${err.message}`);
      }
    } else if (wantsAge) {
      console.log(`  (age-page budget of ${oltAgePages} exhausted — ${show.title} age deferred to next run)`);
    }

    const plan = planOltEnrichment(show, event);
    for (const ch of plan.changes) {
      console.log(`  FILL ${show.title} (${show.id}): ${ch.field} ${ch.old ?? 'null'} -> ${ch.new} [${ch.source}]`);
    }
    for (const sk of plan.skips) {
      // already-set / no-olt-* are the steady state for most rows — only the
      // guard-driven skips are worth a line.
      if (/^(already-set|no-olt-)/.test(sk.reason)) continue;
      console.log(`  SKIP ${show.title} (${show.id}): ${sk.field} — ${sk.reason}`);
    }
    if (plan.changes.length > 0) {
      result.changes.push({ show: show.title, slug: show.slug, id: show.id, changes: plan.changes });
    }
  }

  console.log(`OLT: ${result.changes.length} row(s) to backfill, ${result.skipped} matched row(s) not live, ${result.agePagesFetched} age page(s) fetched`);
  return result;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('='.repeat(60));
  console.log('WEST END DATE ENRICHMENT');
  console.log('='.repeat(60));
  console.log(`Mode: ${verify ? 'VERIFY' : dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (force) console.log('  FORCE mode: will overwrite existing dates');
  if (fixUnconfirmed) console.log('  FIX-UNCONFIRMED mode: will correct shows with todaytix/showscore/unknown sources');
  if (skipOlt) console.log('  SKIP-OLT: Official London Theatre backfill disabled');
  if (oltOnly) console.log('  OLT-ONLY: Theatremonkey/Playbill phases disabled');
  if (showSlug) console.log(`Show filter: ${showSlug}`);
  console.log('');

  // Load shows
  const data = loadShows();
  const allShows = data.shows;

  // Filter to West End shows
  let weShows = allShows.filter(s => s.category === 'west-end' || s.category === 'off-west-end');
  console.log(`West End shows: ${weShows.length}`);

  if (showSlug) {
    weShows = weShows.filter(s => s.slug === showSlug || s.id === showSlug);
    if (weShows.length === 0) {
      console.error(`No WE show found with slug/id: ${showSlug}`);
      process.exit(1);
    }
  }

  // Candidates: shows that need date enrichment
  // - missing-only mode: shows without previewsStartDate
  // - fix-unconfirmed mode: also includes shows with unconfirmed openingDate sources
  //   (todaytix, showscore, unknown, null) — these need press night confirmation
  // The "is this date source unconfirmed?" predicate moved to
  // scripts/lib/date-source-confidence.js (2026-04-28). For West End shows
  // the rule matches the previous inline Set exactly. Off-Broadway adds
  // 'ibdb' to the unconfirmed set — irrelevant here since this script
  // filters to WE/OWE category, but the helper handles category-specific
  // cases so the new OB sibling can reuse it.
  const candidateShows = verify || showSlug
    ? weShows
    : fixUnconfirmed
      ? weShows.filter(s => !s.previewsStartDate || isUnconfirmedDateSource(s))
      : missingOnly
        ? weShows.filter(s => !s.previewsStartDate)
        : weShows;

  console.log(`Candidate shows for enrichment: ${candidateShows.length}`);
  console.log('');

  // Phase 0: Official London Theatre closingDate + ageRecommendation backfill
  // (audit S7-T10). Independent of the TM/PB candidate filter: it fills only
  // null fields on live/recently closed rows, whatever their date sources.
  const oltResult = skipOlt
    ? { changes: [], matched: 0, unmatched: [], skipped: 0, agePagesFetched: 0, events: 0 }
    : await scrapeOfficialLondonTheatre(weShows);

  // Phase 1: Theatremonkey (primary)
  const tmEntries = oltOnly ? [] : await scrapeTheatremonkey(weShows);

  // Phase 2: Playbill (secondary)
  const pbEntries = oltOnly ? [] : await scrapePlaybill();

  // Phase 3: Merge sources
  console.log('');
  console.log('--- MERGING SOURCES ---');
  const entries = mergeSources(tmEntries, pbEntries);
  console.log(`Merged: ${entries.length} unique shows (TM: ${tmEntries.length}, PB: ${pbEntries.length})`);
  console.log('');

  if (entries.length === 0 && !oltOnly) {
    console.warn('WARNING: 0 entries from all sources');
    // In fix-unconfirmed mode, Phase 4 (infer press night from review-date
    // clustering) is a review-data-only fallback that does NOT need any scrape
    // entries — closed shows fall off Theatremonkey/Playbill listings, so they
    // can ONLY be corrected by inference. Exiting here would skip that backfill
    // forever (the weekly cron's TM/PB scrape returning empty was silently
    // leaving ~32 collapsed WE openingDate===previewsStartDate todaytix shows
    // uncorrected). Only bail early when there's genuinely nothing to do —
    // and never while the OLT phase has backfills to apply.
    if (!fixUnconfirmed && oltResult.changes.length === 0) {
      console.log('No changes to apply');
      process.exit(0);
    }
    if (fixUnconfirmed) console.log('Continuing to Phase 4 (review-date inference) despite 0 scrape entries.');
  }

  // Phase 4: Match to shows.json and compute changes
  const changes = [];
  const discrepancies = [];
  const unmatched = [];
  let matchCount = 0;

  for (const entry of entries) {
    const cleaned = cleanTitle(entry.title);
    const result = matchTitleToShow(cleaned, weShows, { market: 'west-end' });

    if (!result || result.confidence !== 'high' || (result.show.category !== 'west-end' && result.show.category !== 'off-west-end')) {
      unmatched.push(entry.title);
      continue;
    }

    matchCount++;
    const show = result.show;
    const isCandidate = candidateShows.some(s => s.id === show.id);
    const showChanges = [];
    const showDiscrepancies = [];

    // Data integrity: preview must be before opening
    if (entry.firstPreview && entry.opening && entry.firstPreview >= entry.opening) {
      console.warn(`  SKIP ${show.title}: preview ${entry.firstPreview} >= opening ${entry.opening} (bad data)`);
      continue;
    }

    // Determine the openingDateSource value for this entry
    // "both" (TM + Playbill agree) → use "theatremonkey" (the primary source)
    const entryDateSource = entry.source === 'both' ? 'theatremonkey' : entry.source;

    // TodayTix mismatch: existing openingDate matches new preview date
    // Also catches shows with unconfirmed sources where we now have a real press night
    const todaytixMismatch = entry.firstPreview && entry.opening && (
      (show.openingDate === entry.firstPreview && !show.previewsStartDate) ||
      (show.openingDate === entry.firstPreview && isUnconfirmedDateSource(show))
    );

    // Same-date fix: openingDate === previewsStartDate and we now have a distinct press night
    const sameDateFix = entry.opening && show.openingDate && show.previewsStartDate &&
      show.openingDate === show.previewsStartDate &&
      entry.opening !== show.openingDate &&
      isUnconfirmedDateSource(show);

    if (todaytixMismatch) {
      showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
      showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
      showChanges.push({ field: 'openingDateSource', old: show.openingDateSource, new: entryDateSource });
      console.log(`  FIX ${show.title}: openingDate ${show.openingDate} is actually preview -> preview=${entry.firstPreview}, opening=${entry.opening} [${entry.source}]`);
    } else if (sameDateFix) {
      showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
      showChanges.push({ field: 'openingDateSource', old: show.openingDateSource, new: entryDateSource });
      if (entry.firstPreview && entry.firstPreview !== show.previewsStartDate) {
        showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
      }
      console.log(`  FIX ${show.title}: same-date ${show.openingDate} corrected -> preview=${entry.firstPreview || show.previewsStartDate}, opening=${entry.opening} [${entry.source}]`);
    } else {
      // Check previewsStartDate
      if (entry.firstPreview) {
        if (!show.previewsStartDate) {
          // Check against both the external opening and existing opening
          const effectiveOpening = entry.opening || show.openingDate;
          if ((effectiveOpening && entry.firstPreview >= effectiveOpening) ||
              (show.openingDate && entry.firstPreview >= show.openingDate)) {
            // Preview date isn't before opening — skip
          } else {
            showChanges.push({ field: 'previewsStartDate', old: null, new: entry.firstPreview });
          }
        } else if (show.previewsStartDate !== entry.firstPreview) {
          if (force && isCandidate) {
            showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
          } else {
            showDiscrepancies.push({ field: 'previewsStartDate', current: show.previewsStartDate, external: entry.firstPreview, source: entry.source });
          }
        }
      }

      // Check openingDate
      if (entry.opening) {
        if (!show.openingDate) {
          showChanges.push({ field: 'openingDate', old: null, new: entry.opening });
          showChanges.push({ field: 'openingDateSource', old: show.openingDateSource || null, new: entryDateSource });
        } else if (show.openingDate !== entry.opening) {
          if ((force || fixUnconfirmed) && isCandidate) {
            showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
            showChanges.push({ field: 'openingDateSource', old: show.openingDateSource || null, new: entryDateSource });
          } else {
            showDiscrepancies.push({ field: 'openingDate', current: show.openingDate, external: entry.opening, source: entry.source });
          }
        } else if (show.openingDate === entry.opening && isUnconfirmedDateSource(show)) {
          // TM/Playbill confirms the existing date — upgrade source to trusted
          // This handles legitimate cold-open shows where preview === press night
          showChanges.push({ field: 'openingDateSource', old: show.openingDateSource || null, new: entryDateSource });
          console.log(`  CONFIRM ${show.title}: openingDate ${show.openingDate} confirmed by ${entryDateSource} (was ${show.openingDateSource || 'null'})`);
        }
      }
    }

    if (showChanges.length > 0 && isCandidate) {
      changes.push({ show: show.title, slug: show.slug, id: show.id, changes: showChanges });
    }
    if (showDiscrepancies.length > 0) {
      discrepancies.push({ show: show.title, slug: show.slug, discrepancies: showDiscrepancies });
    }
  }

  // Phase 4: Infer press nights from review dates (fallback).
  // The detection logic moved to scripts/lib/infer-press-night-from-reviews.js
  // (2026-04-28) so the new off-Broadway sibling can opt-OUT of this phase
  // — sparse OB review counts make the inference too fabrication-prone.
  // For West End the call shape preserves prior behavior exactly.
  if (fixUnconfirmed) {
    console.log('');
    console.log('--- PHASE 4: INFER FROM REVIEW DATES ---');
    const reviewsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'reviews.json'), 'utf8'));
    const allReviews = reviewsData.reviews || [];
    const skipShowIds = new Set(changes.map(c => c.id));
    const inferences = inferPressNightFromReviews({
      candidateShows,
      reviews: allReviews,
      enabled: true,
      skipShowIds,
    });
    for (const inf of inferences) {
      const pressNightIso = inf.changes.find(c => c.field === 'openingDate').new;
      const oldOpening = inf.changes.find(c => c.field === 'openingDate').old;
      // `direction` is 'forward' (cluster after the stored date) or 'reverse'
      // (cluster before it — the BRO-2280 backward-collapsed TodayTix case),
      // so the gap has to be described in the right direction.
      const where = inf.direction === 'reverse' ? 'before' : 'after';
      console.log(`  INFER ${inf.title}: earliest review ${inf.earliestReviewIso} (${inf.clusterSize} within 3d) → press night ${pressNightIso} (${inf.gapDays}d ${where} stored ${oldOpening}${inf.direction === 'reverse' ? ', previewsStartDate cleared' : ''})`);
      changes.push({ show: inf.title, slug: inf.slug, id: inf.id, changes: inf.changes });
    }
    console.log(`Inferred ${inferences.length} press night(s) from review dates`);
  }

  // Phase 0 results join the change list here: the report and the apply
  // loop below treat them like any other change, except closingDate, which
  // the apply loop routes through writeClosingDate().
  changes.push(...oltResult.changes);

  // Report
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log(`Total entries: ${entries.length} (TM: ${tmEntries.length}, PB: ${pbEntries.length})`);
  console.log(`OLT: ${oltResult.events} entries, ${oltResult.matched} matched, ${oltResult.changes.length} row(s) to backfill`);
  console.log(`Matched to shows: ${matchCount}`);
  console.log(`Unmatched: ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.log(`  Unmatched titles: ${unmatched.join(', ')}`);
  }
  console.log(`Changes to apply: ${changes.length}`);
  console.log(`Discrepancies: ${discrepancies.length}`);
  console.log('');

  if (changes.length > 0) {
    console.log('CHANGES:');
    console.log('-'.repeat(60));
    for (const c of changes) {
      console.log(`  ${c.show} (${c.slug}):`);
      for (const ch of c.changes) {
        console.log(`    ${ch.field}: ${ch.old || 'null'} -> ${ch.new}`);
      }
    }
    console.log('');
  }

  if (discrepancies.length > 0) {
    console.log('DISCREPANCIES (existing vs external):');
    console.log('-'.repeat(60));
    for (const d of discrepancies) {
      console.log(`  ${d.show} (${d.slug}):`);
      for (const disc of d.discrepancies) {
        console.log(`    ${disc.field}: shows.json=${disc.current}, ${disc.source}=${disc.external}`);
      }
    }
    console.log('');
  }

  // Apply changes
  let updated = 0;
  if (!dryRun && !verify && changes.length > 0) {
    for (const c of changes) {
      const showRecord = allShows.find(s => s.id === c.id);
      if (!showRecord) continue;

      for (const ch of c.changes) {
        if (ch.field === 'closingDate') {
          // Through the guard: planOltEnrichment already refuses
          // humanCorrectedClosingDate rows, and the guard refuses again at
          // write time (also stamps closingDateSource + closingDateUpdatedAt).
          writeClosingDate(showRecord, ch.new, ch.source || 'olt');
        } else {
          showRecord[ch.field] = ch.new;
        }
      }
      updated++;
    }

    saveShows(data);
    console.log(`Updated ${updated} show(s) in shows.json`);

    // Run validation
    console.log('');
    console.log('Running data validation...');
    try {
      const { execSync } = require('child_process');
      execSync('node scripts/validate-data.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
      console.log('Validation passed');
    } catch (e) {
      console.error('Validation failed! Review changes.');
      process.exit(1);
    }
  } else if (changes.length === 0) {
    console.log('No changes needed');
  } else {
    console.log(`${changes.length} change(s) would be applied (${dryRun ? 'dry run' : 'verify mode'})`);
  }

  // Write GITHUB_OUTPUT
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes_count=${changes.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `updated_count=${updated}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `matched_count=${matchCount}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `entries_count=${entries.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `olt_changes_count=${oltResult.changes.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `olt_matched_count=${oltResult.matched}\n`);
  }

  console.log('');
  console.log('Done.');
}

// Exported for scripts/enrich-west-end-dates.test.mjs — the pure
// parsing/validation/merge functions behind the Theatremonkey + Playbill
// London date enrichment (BRO-3527, cousin of the OB script's BRO-1108
// export shape). Network-calling functions (scrapeTheatremonkey,
// scrapePlaybill) are intentionally NOT exported; they're exercised
// indirectly via --dry-run / --show=SLUG manual verification.
module.exports = {
  parseBritishDate,
  parsePlaybillDate,
  cleanTitle,
  titleToTmSlugs,
  parseTheatremonkeyIndex,
  extractTheatremonkeyDates,
  parsePlaybillSchedulePage,
  mergeSources,
};

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
