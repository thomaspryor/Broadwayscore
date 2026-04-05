#!/usr/bin/env node
/**
 * Enrich shows.json with runtime, dates, and age recommendation data from Wikipedia.
 *
 * Looks for:
 * - Runtime in Infobox fields: runtime, running_time, running time, length
 * - Dates: previews, premiere/opening, closing
 * - Age recommendation from article text
 *
 * Usage: node scripts/enrich-wikipedia-runtimes.js [--dry-run] [--category=off-broadway|west-end|broadway] [--dates-only] [--limit=N]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { cleanSearchTitle } = require('./lib/title-normalization');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_FILTER = process.argv.find(a => a.startsWith('--category='))?.split('=')[1] || null;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const DATES_ONLY = process.argv.includes('--dates-only');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BroadwayScorecardBot/1.0 (broadway-scorecard project)' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function getPageContent(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const data = await fetchJson(url);
  const pages = data.query.pages;
  const pageId = Object.keys(pages)[0];
  if (pageId === '-1') return null;
  const content = pages[pageId].revisions?.[0]?.slots?.main?.['*'] || null;

  // Handle redirects
  if (content) {
    const redirect = content.match(/#REDIRECT\s*\[\[([^\]]+)\]\]/i);
    if (redirect) {
      return getPageContent(redirect[1]);
    }
  }
  return content;
}

function buildSearchTitles(show) {
  const title = cleanSearchTitle(show.title);

  const type = show.type || show.format;
  const variants = [];
  if (type === 'musical') {
    variants.push(`${title} (musical)`, title, `${title} (Musical)`);
  } else if (type === 'play') {
    variants.push(`${title} (play)`, title, `${title} (Play)`);
  } else {
    variants.push(title, `${title} (musical)`, `${title} (play)`);
  }
  return variants;
}

/**
 * Parse runtime text from Wikipedia infobox.
 *
 * Examples:
 *   "2 hours, 30 minutes" → "2h 30m"
 *   "{{Duration|h=2|m=30}}" → "2h 30m"
 *   "Approximately 2 hours and 15 minutes" → "2h 15m"
 *   "150 minutes" → "2h 30m"
 *   "1 hour 45 minutes" → "1h 45m"
 *   "2:30" → "2h 30m"
 */
function parseRuntime(text) {
  if (!text) return null;
  let t = text.trim();

  // Remove wiki markup
  t = t.replace(/\{\{[Dd]uration\|h=(\d+)\|m=(\d+)\}\}/g, '$1 hours $2 minutes');
  t = t.replace(/\{\{[Dd]uration\|m=(\d+)\}\}/g, '$1 minutes');
  t = t.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');
  t = t.replace(/<ref[^>]*>.*?<\/ref>/gis, '');
  t = t.replace(/<ref[^>]*\/>/gi, '');
  t = t.replace(/\{\{[^}]*\}\}/g, '');
  t = t.replace(/<!--.*?-->/gs, '');
  t = t.replace(/['']+/g, '');
  t = t.trim().toLowerCase();

  if (!t || t === 'n/a' || t === 'tbd' || t === 'tba' || t === 'varies') return null;

  // "Xh Ym" already formatted
  const already = t.match(/^(\d+)h\s*(\d+)m$/);
  if (already) return `${parseInt(already[1])}h ${parseInt(already[2])}m`;

  // "X hours and Y minutes" or "X hours, Y minutes"
  const hm = t.match(/(\d+)\s*hours?\s*(?:,?\s*(?:and\s*)?)?(\d+)\s*(?:minutes?|mins?)/);
  if (hm) return `${parseInt(hm[1])}h ${parseInt(hm[2])}m`;

  // "X hours" only
  const hOnly = t.match(/^(?:approximately\s+)?(\d+)\s*hours?$/);
  if (hOnly) return `${parseInt(hOnly[1])}h`;

  // "X minutes" only
  const mOnly = t.match(/^(?:approximately\s+)?(\d+)\s*(?:minutes?|mins?)$/);
  if (mOnly) {
    const mins = parseInt(mOnly[1]);
    if (mins < 30 || mins > 360) return null; // Unrealistic
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  // "X:YY" format
  const colon = t.match(/^(\d+):(\d{2})$/);
  if (colon) {
    const h = parseInt(colon[1]);
    const m = parseInt(colon[2]);
    if (h >= 1 && h <= 5 && m < 60) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  return null;
}

/**
 * Extract intermission count from Wikipedia text near the runtime.
 */
function parseIntermissions(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/no\s+intermission|without\s+intermission|no\s+interval/i.test(t)) return 0;
  if (/one\s+intermission|1\s+intermission|one\s+interval|1\s+interval/i.test(t)) return 1;
  if (/two\s+intermissions?|2\s+intermissions?|two\s+intervals?|2\s+intervals?/i.test(t)) return 2;
  return null;
}

/**
 * Parse a date from Wikipedia infobox value.
 * Handles: "{{Start date|2024|3|15}}", "March 15, 2024", "15 March 2024", "2024-03-15"
 * Returns ISO date string "YYYY-MM-DD" or null.
 */
function parseWikiDate(text) {
  if (!text) return null;
  let t = text.trim();

  // Remove ref tags and comments
  t = t.replace(/<ref[^>]*>.*?<\/ref>/gis, '');
  t = t.replace(/<ref[^>]*\/>/gi, '');
  t = t.replace(/<!--.*?-->/gs, '');

  // {{Start date|YYYY|M|D}} or {{End date|YYYY|M|D}}
  const tmpl = t.match(/\{\{(?:Start|End)\s*date\|(\d{4})\|(\d{1,2})\|(\d{1,2})/i);
  if (tmpl) {
    return `${tmpl[1]}-${tmpl[2].padStart(2, '0')}-${tmpl[3].padStart(2, '0')}`;
  }

  // Plain wiki links: [[March 15]], [[2024]]
  t = t.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');
  t = t.replace(/\{\{[^}]*\}\}/g, '').trim();

  // "March 15, 2024" or "15 March 2024"
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const mdy = t.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy && months[mdy[1].toLowerCase()]) {
    const m = months[mdy[1].toLowerCase()];
    return `${mdy[3]}-${String(m).padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }
  const dmy = t.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dmy && months[dmy[2].toLowerCase()]) {
    const m = months[dmy[2].toLowerCase()];
    return `${dmy[3]}-${String(m).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }

  // ISO format "2024-03-15"
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];

  return null;
}

/**
 * Extract dates from Wikipedia infobox content.
 * Returns { previewsStartDate, openingDate, closingDate } (any may be null).
 */
function extractDates(content) {
  const result = { previewsStartDate: null, openingDate: null, closingDate: null };

  // Previews: | previews = ... or | preview_date = ...
  const previews = content.match(/\|\s*(?:previews|preview_date|preview date)\s*=\s*(.+?)(?:\n\||\n\}\})/si);
  if (previews) result.previewsStartDate = parseWikiDate(previews[1]);

  // Opening/premiere: | premiere_date = ... or | premiere = ... or | opening = ... or | opening_date = ...
  const premiere = content.match(/\|\s*(?:premiere_date|premiere date|premiere|opening_date|opening date|opening)\s*=\s*(.+?)(?:\n\||\n\}\})/si);
  if (premiere) result.openingDate = parseWikiDate(premiere[1]);

  // Closing: | closing = ... or | closing_date = ...
  const closing = content.match(/\|\s*(?:closing_date|closing date|closing)\s*=\s*(.+?)(?:\n\||\n\}\})/si);
  if (closing) result.closingDate = parseWikiDate(closing[1]);

  return result;
}

/**
 * Validate a Wikipedia date against the show's TodayTix startDate.
 * Rejects dates more than 2 years away (likely wrong production).
 */
function isDatePlausible(wikiDate, show) {
  if (!wikiDate || !show.openingDate) return true; // Can't validate, accept
  const wiki = new Date(wikiDate);
  const existing = new Date(show.openingDate);
  const diffYears = Math.abs(wiki - existing) / (365.25 * 24 * 60 * 60 * 1000);
  return diffYears < 2;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  let targets;
  if (DATES_ONLY) {
    // Only target shows missing preview dates (most common gap for OB/WE)
    targets = shows.filter(s => !s.previewsStartDate && (s.status === 'open' || s.status === 'previews'));
  } else {
    targets = shows.filter(s => !s.runtime || !s.previewsStartDate);
  }

  if (CATEGORY_FILTER) {
    targets = targets.filter(s => (s.category || 'broadway') === CATEGORY_FILTER);
    console.log(`Filtering to category: ${CATEGORY_FILTER}`);
  }

  if (LIMIT > 0) {
    targets = targets.slice(0, LIMIT);
    console.log(`Limiting to ${LIMIT} shows`);
  }

  console.log(`Total shows: ${shows.length}`);
  console.log(`Targets: ${targets.length}${DATES_ONLY ? ' (dates only)' : ''}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  let enriched = 0, datesEnriched = 0, notFound = 0, noRuntime = 0, errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const show = targets[i];
    const searchTitles = buildSearchTitles(show);

    process.stdout.write(`[${i + 1}/${targets.length}] ${show.id}... `);

    let content = null;
    for (const title of searchTitles) {
      try {
        content = await getPageContent(title);
        if (content) break;
      } catch (e) {
        errors++;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!content) {
      console.log('NOT FOUND');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Validate this is a theatrical production page
    const hasInfobox = /\{\{Infobox (musical|play|film|television)/i.test(content);
    const hasTheatreContext = /\b(broadway|west end|off-broadway|theatre|theater|musical|playwright|librett)/i.test(content.substring(0, 2000));
    if (!hasInfobox && !hasTheatreContext) {
      console.log('not a theatre page');
      notFound++;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    const parts = [];

    // Extract runtime from infobox (skip if already have runtime or dates-only mode)
    if (!show.runtime && !DATES_ONLY) {
      const runtimeMatch = content.match(/\|\s*(?:runtime|running[_ ]time|length)\s*=\s*(.+?)(?:\n\||\n\}\})/si);
      if (runtimeMatch) {
        const runtime = parseRuntime(runtimeMatch[1]);
        if (runtime) {
          if (!DRY_RUN) show.runtime = runtime;
          parts.push(`runtime=${runtime}`);
          enriched++;
        }

        // Check for intermission info near runtime
        const intermissions = parseIntermissions(runtimeMatch[1]);
        if (intermissions !== null && show.intermissions === undefined) {
          if (!DRY_RUN) show.intermissions = intermissions;
          parts.push(`intermissions=${intermissions}`);
        }
      }
    }

    // Extract dates from infobox
    const dates = extractDates(content);
    let dateUpdated = false;

    if (dates.previewsStartDate && !show.previewsStartDate && isDatePlausible(dates.previewsStartDate, show)) {
      if (!DRY_RUN) show.previewsStartDate = dates.previewsStartDate;
      parts.push(`previews=${dates.previewsStartDate}`);
      dateUpdated = true;
    }
    if (dates.openingDate && !show.openingDate && isDatePlausible(dates.openingDate, show)) {
      if (!DRY_RUN) show.openingDate = dates.openingDate;
      parts.push(`opening=${dates.openingDate}`);
      dateUpdated = true;
    }
    if (dates.closingDate && !show.closingDate && isDatePlausible(dates.closingDate, show)) {
      if (!DRY_RUN) show.closingDate = dates.closingDate;
      parts.push(`closing=${dates.closingDate}`);
      dateUpdated = true;
    }
    if (dateUpdated) datesEnriched++;

    if (parts.length === 0) {
      console.log('no enrichable data');
      noRuntime++;
    } else {
      console.log(parts.join(', '));
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Runtime enriched: ${enriched}`);
  console.log(`Dates enriched: ${datesEnriched}`);
  console.log(`Not found on Wikipedia: ${notFound}`);
  console.log(`Found but no enrichable data: ${noRuntime}`);
  console.log(`Errors: ${errors}`);

  if (!DRY_RUN && (enriched > 0 || datesEnriched > 0)) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
