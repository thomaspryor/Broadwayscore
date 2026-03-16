#!/usr/bin/env node
/**
 * West End Date Enrichment Script
 *
 * Enriches West End shows in shows.json with preview start dates and opening
 * (press night) dates from two sources:
 *   1. Theatremonkey.com (primary, ~80+ shows with structured Press Night dates)
 *   2. Playbill London schedule (secondary, ~15 shows, cross-validates)
 *
 * Usage:
 *   node scripts/enrich-west-end-dates.js [options]
 *
 * Options:
 *   --dry-run       Show what would change without modifying files
 *   --show=SLUG     Only process a specific show by slug
 *   --verify        Compare dates vs shows.json, report discrepancies (no writes)
 *   --force         Overwrite existing dates
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { matchTitleToShow } = require('./lib/show-matching');

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
const missingOnly = !force;

const showArg = args.find(a => a.startsWith('--show='));
const showSlug = showArg ? showArg.split('=')[1] : null;

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(url) {
  const response = await fetch(url, { headers: FETCH_HEADERS });
  if (!response.ok) return null;
  return response.text();
}

/**
 * Clean title for better matching — strip common prefixes
 */
function cleanTitle(title) {
  return title
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

  // Match titles to our shows FIRST, then only fetch matched pages
  const matched = [];
  for (const entry of indexEntries) {
    const cleaned = cleanTitle(entry.title);
    const result = matchTitleToShow(cleaned, weShows, { market: 'west-end' });
    if (result && (result.show.category === 'west-end' || result.show.category === 'off-west-end')) {
      matched.push({ ...entry, show: result.show, confidence: result.confidence });
    }
  }
  console.log(`Matched ${matched.length} to our WE shows (skipping ${indexEntries.length - matched.length} unmatched)`);
  console.log('');

  // Fetch each matched show page
  const entries = [];
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
// MAIN
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('WEST END DATE ENRICHMENT');
  console.log('='.repeat(60));
  console.log(`Mode: ${verify ? 'VERIFY' : dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (force) console.log('  FORCE mode: will overwrite existing dates');
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

  // Candidates: shows missing previewsStartDate (in missing-only mode)
  const candidateShows = missingOnly && !verify && !showSlug
    ? weShows.filter(s => !s.previewsStartDate)
    : weShows;

  console.log(`Candidate shows for enrichment: ${candidateShows.length}`);
  console.log('');

  // Phase 1: Theatremonkey (primary)
  const tmEntries = await scrapeTheatremonkey(weShows);

  // Phase 2: Playbill (secondary)
  const pbEntries = await scrapePlaybill();

  // Phase 3: Merge sources
  console.log('');
  console.log('--- MERGING SOURCES ---');
  const entries = mergeSources(tmEntries, pbEntries);
  console.log(`Merged: ${entries.length} unique shows (TM: ${tmEntries.length}, PB: ${pbEntries.length})`);
  console.log('');

  if (entries.length === 0) {
    console.warn('WARNING: 0 entries from all sources');
    console.log('No changes to apply');
    process.exit(0);
  }

  // Phase 4: Match to shows.json and compute changes
  const changes = [];
  const discrepancies = [];
  const unmatched = [];
  let matchCount = 0;

  for (const entry of entries) {
    const cleaned = cleanTitle(entry.title);
    const result = matchTitleToShow(cleaned, weShows, { market: 'west-end' });

    if (!result || (result.show.category !== 'west-end' && result.show.category !== 'off-west-end')) {
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

    // TodayTix mismatch: existing openingDate matches new preview date
    const todaytixMismatch = entry.firstPreview && entry.opening &&
      show.openingDate === entry.firstPreview && !show.previewsStartDate;

    if (todaytixMismatch) {
      showChanges.push({ field: 'previewsStartDate', old: null, new: entry.firstPreview });
      showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
      console.log(`  FIX ${show.title}: openingDate ${show.openingDate} is actually preview -> preview=${entry.firstPreview}, opening=${entry.opening} [${entry.source}]`);
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
        } else if (show.openingDate !== entry.opening) {
          if (force && isCandidate) {
            showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
          } else {
            showDiscrepancies.push({ field: 'openingDate', current: show.openingDate, external: entry.opening, source: entry.source });
          }
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

  // Report
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log(`Total entries: ${entries.length} (TM: ${tmEntries.length}, PB: ${pbEntries.length})`);
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
        showRecord[ch.field] = ch.new;
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
  }

  console.log('');
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
