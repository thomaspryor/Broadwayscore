#!/usr/bin/env node
/**
 * Playbill London Date Enrichment Script
 *
 * Enriches West End shows in shows.json with preview start dates and opening
 * (press night) dates from Playbill's London schedule page.
 *
 * Usage:
 *   node scripts/enrich-playbill-london-dates.js [options]
 *
 * Options:
 *   --dry-run       Show what would change without modifying files
 *   --show=SLUG     Only process a specific show by slug
 *   --verify        Compare Playbill dates vs shows.json, report discrepancies (no writes)
 *   --force         Overwrite existing dates with Playbill values
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { matchTitleToShow } = require('./lib/show-matching');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const PLAYBILL_URL = 'https://playbill.com/article/schedule-of-upcoming-london-shows';

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

/**
 * Parse "Month Day, Year" into YYYY-MM-DD
 */
function parsePlaybillDate(text) {
  const months = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12'
  };

  const match = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!match) return null;

  const month = months[match[1].toLowerCase()];
  const day = match[2].padStart(2, '0');
  const year = match[3];

  // Sanity check year
  const y = parseInt(year);
  if (y < 2024 || y > 2028) return null;

  return `${year}-${month}-${day}`;
}

/**
 * Parse Playbill London schedule HTML into show entries
 */
function parseSchedulePage(html) {
  const $ = cheerio.load(html);
  const entries = [];
  let currentEntry = null;

  // The article body contains show entries as:
  // <strong> or <b> with show title (often linked)
  // followed by <ul><li> items with Theatre:, First Preview:, Opening:

  // Strategy: walk all elements in article content, detect title blocks and metadata
  const articleBody = $('[class*="article"] p, [class*="article"] ul, [class*="article"] strong, [class*="article"] b, [class*="article"] h2, [class*="article"] h3').toArray();

  // Fallback: if no article-class container, try the whole body
  const elements = articleBody.length > 0 ? articleBody : $('p, ul, strong, b, h2, h3').toArray();

  for (const el of elements) {
    const tagName = el.tagName?.toLowerCase();

    // Detect show titles in <strong>, <b>, <h2>, <h3> tags
    if (tagName === 'strong' || tagName === 'b' || tagName === 'h2' || tagName === 'h3') {
      const text = $(el).text().trim();
      // Title heuristic: 3+ chars, doesn't start with common metadata labels
      if (text.length >= 3 &&
          !text.match(/^(Theatre|Theater|First Preview|Opening|Opens|Book|Music|Lyrics|Director|Playwright|Cast|Starring|Written|Choreograph)/i) &&
          !text.includes(':')) {
        if (currentEntry) entries.push(currentEntry);
        currentEntry = { title: text, firstPreview: null, opening: null, theatre: null };
      }
    }

    // Extract metadata from <ul> children
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

    // Also handle metadata in <p> tags (some articles use paragraphs instead of lists)
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

  // Don't forget the last entry
  if (currentEntry) entries.push(currentEntry);

  return entries;
}

async function main() {
  console.log('='.repeat(60));
  console.log('PLAYBILL LONDON DATE ENRICHMENT');
  console.log('='.repeat(60));
  console.log(`Mode: ${verify ? 'VERIFY' : dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (force) console.log('  FORCE mode: will overwrite existing dates');
  if (showSlug) console.log(`Show filter: ${showSlug}`);
  console.log('');

  // Load shows
  const data = loadShows();
  const allShows = data.shows;

  // Filter to West End shows
  let weShows = allShows.filter(s => s.category === 'west-end');
  console.log(`West End shows: ${weShows.length}`);

  if (showSlug) {
    weShows = weShows.filter(s => s.slug === showSlug || s.id === showSlug);
    if (weShows.length === 0) {
      console.error(`No WE show found with slug/id: ${showSlug}`);
      process.exit(1);
    }
  }

  // In missing-only mode, include shows missing previewsStartDate
  // (even if they have openingDate — TodayTix often puts preview date as openingDate)
  const candidateShows = missingOnly && !verify && !showSlug
    ? weShows.filter(s => !s.previewsStartDate)
    : weShows;

  console.log(`Candidate shows for enrichment: ${candidateShows.length}`);
  console.log('');

  // Fetch Playbill London schedule page
  console.log(`Fetching: ${PLAYBILL_URL}`);
  let html;
  try {
    const response = await fetch(PLAYBILL_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)',
        'Accept': 'text/html'
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    html = await response.text();
    console.log(`Fetched ${(html.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.error(`Failed to fetch Playbill page: ${err.message}`);
    process.exit(1);
  }

  // Parse show entries from HTML
  const entries = parseSchedulePage(html);
  console.log(`Parsed ${entries.length} show entries from Playbill`);

  if (entries.length === 0) {
    console.warn('WARNING: 0 entries found — page structure may have changed');
    console.log('');
    console.log('No changes to apply');
    process.exit(0);
  }

  // Log parsed entries
  console.log('');
  console.log('Parsed entries:');
  for (const e of entries) {
    console.log(`  ${e.title} | Preview: ${e.firstPreview || '—'} | Opening: ${e.opening || '—'} | Theatre: ${e.theatre || '—'}`);
  }
  console.log('');

  // Match entries to shows and track changes
  const changes = [];
  const discrepancies = [];
  const unmatched = [];
  let matchCount = 0;

  for (const entry of entries) {
    // Match using all WE shows (not just candidates) for better matching
    const result = matchTitleToShow(entry.title, weShows, { market: 'west-end' });

    if (!result || result.show.category !== 'west-end') {
      unmatched.push(entry.title);
      continue;
    }

    matchCount++;
    const show = result.show;

    // Check if this show is in our candidate list
    const isCandidate = candidateShows.some(s => s.id === show.id);

    const showChanges = [];
    const showDiscrepancies = [];

    // Data integrity: Playbill's preview must be before its opening
    if (entry.firstPreview && entry.opening && entry.firstPreview >= entry.opening) {
      console.warn(`  SKIP ${show.title}: parsed preview ${entry.firstPreview} >= parsed opening ${entry.opening} (bad data)`);
      continue;
    }

    // KEY INSIGHT: TodayTix often sets openingDate to the first preview date (startDate).
    // When Playbill has both dates and our openingDate matches Playbill's preview date,
    // we should: (1) set previewsStartDate to the preview, (2) correct openingDate to press night.
    const todaytixMismatch = entry.firstPreview && entry.opening &&
      show.openingDate === entry.firstPreview && !show.previewsStartDate;

    if (todaytixMismatch) {
      // Our "openingDate" is actually the preview date — fix both fields
      showChanges.push({ field: 'previewsStartDate', old: null, new: entry.firstPreview });
      showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
      console.log(`  FIX ${show.title}: openingDate ${show.openingDate} is actually preview date -> preview=${entry.firstPreview}, opening=${entry.opening}`);
    } else {
      // Standard field-by-field comparison

      // Check previewsStartDate
      if (entry.firstPreview) {
        if (!show.previewsStartDate) {
          // Preview must be before opening (use Playbill opening if available, else existing)
          const effectiveOpening = entry.opening || show.openingDate;
          if (effectiveOpening && entry.firstPreview >= effectiveOpening) {
            console.warn(`  SKIP ${show.title}: preview ${entry.firstPreview} >= opening ${effectiveOpening}`);
          } else {
            showChanges.push({ field: 'previewsStartDate', old: null, new: entry.firstPreview });
          }
        } else if (show.previewsStartDate !== entry.firstPreview) {
          if (force && isCandidate) {
            showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
          } else {
            showDiscrepancies.push({ field: 'previewsStartDate', current: show.previewsStartDate, playbill: entry.firstPreview });
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
            showDiscrepancies.push({ field: 'openingDate', current: show.openingDate, playbill: entry.opening });
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
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log(`Playbill entries: ${entries.length}`);
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
    console.log('DISCREPANCIES (existing vs Playbill):');
    console.log('-'.repeat(60));
    for (const d of discrepancies) {
      console.log(`  ${d.show} (${d.slug}):`);
      for (const disc of d.discrepancies) {
        console.log(`    ${disc.field}: shows.json=${disc.current}, playbill=${disc.playbill}`);
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
