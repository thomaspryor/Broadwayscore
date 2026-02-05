#!/usr/bin/env node
/**
 * check-closing-dates.js
 *
 * Weekly check for Broadway closing date changes:
 * 1. Finds NEW closing dates for shows without one
 * 2. Detects EXTENSIONS (closing date pushed later) - common marketing tactic
 * 3. Flags discrepancies for review
 *
 * Usage: node scripts/check-closing-dates.js [--dry-run]
 *
 * Environment variables:
 *   BRIGHTDATA_TOKEN - Bright Data API token (primary)
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key (fallback)
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const BROADWAY_ORG_URL = 'https://www.broadway.org/shows/';

const dryRun = process.argv.includes('--dry-run');

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

// Scraping is now handled by shared lib/scraper.js module

function parseClosingDate(text) {
  // Try to parse various date formats:
  // Broadway.org format: "Through: Mar 8, 2026" (inside <span class="regular">)
  // Alternative: "Closes February 8, 2026", "Closing Date: Feb 8, 2026"
  const patterns = [
    /Through:.*?<span[^>]*class="regular"[^>]*>([^<]+)</i,
    /Through:\s*(?:&nbsp;)?(\w+\s+\d{1,2},?\s*\d{4})/i,
    /Through:\s*(?:&nbsp;)?(\w+\s+\d{1,2})/i,
    /(?:closes?|closing|through|ends?|final)[:\s]+(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:closes?|closing|through|ends?|final)[:\s]+(\w+\s+\d{1,2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const dateStr = match[1];
      // Add current year if not present
      const hasYear = /\d{4}/.test(dateStr);
      const fullDateStr = hasYear ? dateStr : `${dateStr}, ${new Date().getFullYear()}`;

      try {
        const date = new Date(fullDateStr);
        if (!isNaN(date.getTime())) {
          // If date is in the past, assume next year
          if (date < new Date() && !hasYear) {
            date.setFullYear(date.getFullYear() + 1);
          }
          return date.toISOString().split('T')[0];
        }
      } catch (e) {
        // Continue to next pattern
      }
    }
  }
  return null;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[!?'":,\-–—]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

async function checkClosingDates() {
  console.log('='.repeat(60));
  console.log('BROADWAY CLOSING DATE CHECK');
  console.log('='.repeat(60));
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const openShows = data.shows.filter(s => s.status === 'open');
  const showsWithoutClosingDate = openShows.filter(s => !s.closingDate);
  const showsWithClosingDate = openShows.filter(s => s.closingDate);

  console.log(`Open shows: ${openShows.length}`);
  console.log(`Without closing date: ${showsWithoutClosingDate.length}`);
  console.log(`With closing date: ${showsWithClosingDate.length}`);
  console.log('');

  // Create lookup map for ALL open shows (to check for extensions too)
  // Multiple keys per show to handle title variations (subtitles, short names)
  const showLookup = {};
  for (const show of openShows) {
    const normalized = normalizeTitle(show.title);
    showLookup[normalized] = show;
    // Also index by title before colon/dash (handles "SIX: The Musical" → "SIX")
    const beforeColon = show.title.replace(/[:–—].*$/, '').trim();
    if (beforeColon !== show.title) {
      showLookup[normalizeTitle(beforeColon)] = show;
    }
    // Also index by slug (handles Broadway.org href matching)
    if (show.slug) showLookup[show.slug] = show;
    if (show.id) showLookup[show.id] = show;
  }

  if (showsWithoutClosingDate.length > 0) {
    console.log('Shows needing closing dates:');
    for (const show of showsWithoutClosingDate) {
      console.log(`  - ${show.title}`);
    }
    console.log('');
  }

  if (showsWithClosingDate.length > 0) {
    console.log('Shows to check for extensions:');
    for (const show of showsWithClosingDate) {
      console.log(`  - ${show.title} (current: ${show.closingDate})`);
    }
    console.log('');
  }

  // Try to fetch Broadway.org
  console.log('Fetching Broadway.org for closing date announcements...');

  try {
    const result = await fetchPage(BROADWAY_ORG_URL, { renderJs: false });
    const html = result.content;

    console.log(`Fetched ${html.length} bytes (${result.format} from ${result.source})`);

    // Guard: content must be reasonably sized for a page listing 30+ shows
    if (html.length < 5000) {
      console.error(`GUARD: Fetched content suspiciously short (${html.length} bytes). Possible error page.`);
      console.error('Skipping closing date check to avoid silent failure.');
      return;
    }

    const newDates = [];      // Shows that didn't have a date
    const extensions = [];    // Shows where the date moved later (extended!)

    // Track how many shows we find on Broadway.org for validation
    let showsFoundOnPage = 0;

    // Method 1: Parse HTML show listing blocks (only works with HTML content)
    if (result.format === 'html') {
      // Broadway.org uses <div class="item filter-data-hook ..."> blocks
      // with <h4 class="notranslate"> for titles and "Through:" for closing dates
      const showBlocks = html.match(/<div\s+class="item\s+filter-data-hook[^"]*"[\s\S]*?(?=<div\s+class="item\s+filter-data-hook|$)/gi) || [];
      console.log(`  HTML parsing: found ${showBlocks.length} show blocks`);

      for (const block of showBlocks) {
        // Try h4.notranslate first (current Broadway.org), fall back to h2/h3
        const titleMatch = block.match(/<h4[^>]*class="notranslate"[^>]*>([^<]+)<\/h4>/i)
          || block.match(/name="([^"]+)"\s+class="bgimg"/i)
          || block.match(/<h[234][^>]*>([^<]+)<\/h[234]>/i);
        if (!titleMatch) continue;

        const title = titleMatch[1].trim()
          .replace(/&amp;/g, '&')
          .replace(/&nbsp;/g, ' ')
          .replace(/&#39;/g, "'");
        const normalized = normalizeTitle(title);
        // Also try title before colon (Broadway.org adds ": A New Musical" etc.)
        const normalizedShort = normalizeTitle(title.replace(/[:–—].*$/, '').trim());
        // Also try matching via href slug (e.g., /shows/mj-the-musical → mj-the-musical)
        const hrefMatch = block.match(/href="\/shows\/([^"]+)"/i);
        const hrefSlug = hrefMatch ? hrefMatch[1] : null;

        const show = showLookup[normalized]
          || showLookup[normalizedShort]
          || (hrefSlug && showLookup[hrefSlug]);
        if (!show) continue;
        showsFoundOnPage++;

        const scrapedDate = parseClosingDate(block);
        if (scrapedDate) {
          if (!show.closingDate) {
            newDates.push({
              id: show.id,
              title: show.title,
              closingDate: scrapedDate,
              type: 'new',
            });
          } else if (scrapedDate > show.closingDate) {
            extensions.push({
              id: show.id,
              title: show.title,
              oldDate: show.closingDate,
              closingDate: scrapedDate,
              type: 'extension',
            });
          }
        }
      }
    } else {
      console.log(`  Content is ${result.format} (not HTML) — skipping article block parsing`);
    }

    // Method 2: Broader text-based search (works with both HTML and markdown)
    const closingPattern = result.format === 'markdown'
      ? /([A-Z][^\n]{2,50}?)\s*(?:closes?|closing|through)[:\s]+(\w+\s+\d{1,2},?\s*\d{0,4})/gi
      : /([A-Z][^<]{2,50}?)(?:<[^>]+>)*\s*(?:closes?|closing|through)[:\s]+(\w+\s+\d{1,2},?\s*\d{0,4})/gi;

    const closingMatches = html.matchAll(closingPattern);
    for (const match of closingMatches) {
      const title = match[1].replace(/<[^>]+>/g, '').trim();
      const normalized = normalizeTitle(title);
      const show = showLookup[normalized];

      if (show && !newDates.find(u => u.id === show.id) && !extensions.find(u => u.id === show.id)) {
        showsFoundOnPage++;
        const scrapedDate = parseClosingDate(match[0]);
        if (scrapedDate) {
          if (!show.closingDate) {
            newDates.push({
              id: show.id,
              title: show.title,
              closingDate: scrapedDate,
              type: 'new',
            });
          } else if (scrapedDate > show.closingDate) {
            extensions.push({
              id: show.id,
              title: show.title,
              oldDate: show.closingDate,
              closingDate: scrapedDate,
              type: 'extension',
            });
          }
        }
      }
    }

    console.log(`  Matched ${showsFoundOnPage} of ${openShows.length} open shows on page`);

    // Guard: if zero shows matched and we have open shows, warn about possible scraper breakage
    if (showsFoundOnPage === 0 && openShows.length > 0) {
      console.warn(`\nWARN: Scraper matched 0/${openShows.length} open shows on Broadway.org.`);
      console.warn('Possible causes: HTML structure changed, title normalization mismatch, or content format issue.');
      console.warn(`Content format: ${result.format}, source: ${result.source}, length: ${html.length} bytes`);
    }

    // Report and apply new closing dates
    if (newDates.length > 0) {
      console.log('');
      console.log('NEW CLOSING DATES:');
      console.log('-'.repeat(40));
      for (const update of newDates) {
        console.log(`  📅 ${update.title}: ${update.closingDate}`);

        if (!dryRun) {
          const show = data.shows.find(s => s.id === update.id);
          if (show) {
            show.closingDate = update.closingDate;
          }
        }
      }
    }

    // Report and apply extensions
    if (extensions.length > 0) {
      console.log('');
      console.log('🎉 EXTENSIONS DETECTED (closing date pushed later):');
      console.log('-'.repeat(40));
      for (const update of extensions) {
        console.log(`  📅 ${update.title}: ${update.oldDate} → ${update.closingDate}`);

        if (!dryRun) {
          const show = data.shows.find(s => s.id === update.id);
          if (show) {
            show.closingDate = update.closingDate;
          }
        }
      }
    }

    const totalUpdates = newDates.length + extensions.length;
    if (totalUpdates > 0) {
      if (!dryRun) {
        saveShows(data);
        console.log('');
        console.log(`✅ Updated ${totalUpdates} shows (${newDates.length} new, ${extensions.length} extensions)`);
      }
    } else {
      console.log('');
      console.log('No closing date changes found in scrape.');
      console.log('(This may require manual checking of Broadway news sources)');
    }

  } catch (error) {
    console.error('Error fetching data:', error.message);
  } finally {
    await cleanup();
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('TIP: For shows without announced closing dates, check:');
  console.log('  - https://www.broadway.org/shows/');
  console.log('  - https://playbill.com/article/broadway-grosses');
  console.log('  - https://www.broadwayworld.com/');
  console.log('='.repeat(60));
}

// Run
checkClosingDates();
