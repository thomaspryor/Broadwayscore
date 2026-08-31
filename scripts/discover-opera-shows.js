#!/usr/bin/env node
/**
 * discover-opera-shows.js
 *
 * Discovers Met Opera productions from metopera.org season pages and adds
 * new shows to shows.json + opera-show-ids.ts.
 *
 * Source: metopera.org/season/YYYY-YY-season/ (BrightData/ScrapingBee fetch,
 * renderJs=true). The season page embeds structured production cards with
 * composer, date-range, and title in CSS-classed elements.
 *
 * Usage:
 *   node scripts/discover-opera-shows.js [--dry-run] [--season=2025-26] [--season=2026-27]
 *   node scripts/discover-opera-shows.js --dry-run         # preview all seasons
 *
 * By default scans both 2025-26 and 2026-27 season pages.
 *
 * Flags:
 *   --dry-run      Print what would be added; do not write files.
 *   --season=SLUG  Only scan the named season (e.g. 2025-26). Repeatable.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const showsWriteGuard = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `discover-opera-shows.js — Discovers Met Opera productions from metopera.org season pages and adds.

Usage:
  node scripts/discover-opera-shows.js [options]
  node scripts/discover-opera-shows.js --help, -h    print this usage and exit
`;
// hygiene-help-flag-ok: audit-help-flag-safety.js's risky-call regex matches this file's own local saveShows(data) wrapper DECLARATION (`function saveShows(data) {`), not a call — the wrapper is only invoked from inside main(), well after the --help guard. Verified: node <this file> --help exits immediately with no fs/network side effects.
// opera-show-ids.ts lives in the source tree — find it relative to __dirname
// regardless of whether we're in the main repo or a worktree.
const OPERA_IDS_FILE = (() => {
  const candidates = [
    path.join(__dirname, '..', 'src', 'lib', 'opera-show-ids.ts'),
    path.join('/Users/tompryor/Broadwayscore', 'src', 'lib', 'opera-show-ids.ts'),
  ];
  return candidates.find(p => { try { fs.accessSync(p); return true; } catch { return false; } })
    || candidates[0];
})();

const dryRun = process.argv.includes('--dry-run');

// Which seasons to scan (default: current + next)
const seasonArgs = process.argv.filter(a => a.startsWith('--season=')).map(a => a.split('=')[1]);
const SEASONS = seasonArgs.length > 0 ? seasonArgs : ['2025-26', '2026-27'];

// ─── Non-opera filters ──────────────────────────────────────────────────────
// Met Opera season pages include concerts, symphonies, and special events
// that are NOT opera productions we want to track.
const NON_OPERA_TITLE_PATTERNS = [
  'in concert',
  'grand finals concert',
  'laffont',
  'met orchestra',
  'carnegie hall',
  'jubilee',
  'symphony',
  'mahler',
  'holiday presentation', // The Magic Flute—Holiday Presentation (family/abridged version)
];

function isNonOpera(title) {
  const t = title.toLowerCase();
  return NON_OPERA_TITLE_PATTERNS.some(p => t.includes(p));
}

// ─── Date parsing ────────────────────────────────────────────────────────────
const MONTH_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse "Sep 22 - Oct 20" into { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
 * using the season's first year (e.g. 2025 for "2025-26") as context.
 * Sep–Dec belong to firstYear; Jan–Aug belong to firstYear+1.
 */
function parseDateRange(raw, seasonFirstYear) {
  if (!raw) return { start: null, end: null };
  // Normalize html entities
  const cleaned = raw.replace(/&[a-z]+;/g, '').replace(/\s+/g, ' ').trim();
  // Single date: "Nov 18" or "Mar 22"
  const singleMatch = cleaned.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
  if (singleMatch) {
    const d = resolveDate(singleMatch[1], parseInt(singleMatch[2], 10), seasonFirstYear);
    return { start: d, end: d };
  }
  // Range: "Sep 22 - Oct 20" or "Dec 31 - Jan 30"
  const rangeMatch = cleaned.match(/^([A-Za-z]{3})\s+(\d{1,2})\s*[-–]\s*([A-Za-z]{3})\s+(\d{1,2})$/);
  if (rangeMatch) {
    const start = resolveDate(rangeMatch[1], parseInt(rangeMatch[2], 10), seasonFirstYear);
    const end = resolveDate(rangeMatch[3], parseInt(rangeMatch[4], 10), seasonFirstYear);
    return { start, end };
  }
  return { start: null, end: null };
}

function resolveDate(monthStr, day, seasonFirstYear) {
  const m = MONTH_MAP[monthStr.toLowerCase().slice(0, 3)];
  if (!m) return null;
  // Sep–Dec = seasonFirstYear; Jan–Aug = seasonFirstYear+1
  const year = m >= 9 ? seasonFirstYear : seasonFirstYear + 1;
  return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ─── Slug construction ───────────────────────────────────────────────────────
function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/['']/g, '')       // strip apostrophes (e.g. "L'elisir" → "lelisir")
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Build the show ID. Pattern: {title-slug}-off-broadway-{year}
 * where year = opening year.
 */
function buildShowId(title, openingYear) {
  return `${slugify(title)}-off-broadway-${openingYear}`;
}

/**
 * The ID prefix stored in opera-show-ids.ts (without the trailing year).
 * e.g. "macbeth-off-broadway"
 */
function buildIdPrefix(title) {
  return `${slugify(title)}-off-broadway`;
}

// ─── Status from dates ───────────────────────────────────────────────────────
function deriveStatus(openingDate, closingDate) {
  const today = new Date().toISOString().slice(0, 10);
  if (closingDate && closingDate < today) return 'closed';
  if (openingDate && openingDate > today) return 'upcoming';
  return 'open';
}

// ─── Season page scraping ────────────────────────────────────────────────────
async function scrapeSeasonPage(seasonSlug) {
  const url = `https://www.metopera.org/season/${seasonSlug}-season/`;
  console.log(`\nFetching ${url}…`);
  const result = await fetchPage(url, { forceMethod: 'scrapingbee', renderJs: true });
  const html = result.html || result.text || result;
  return typeof html === 'string' ? html : JSON.stringify(html);
}

function parseSeasonProductions(html, seasonSlug) {
  // Season slug like "2025-26" → firstYear = 2025
  const firstYear = parseInt(seasonSlug.split('-')[0], 10);

  const pretitleRegex = /<p[^>]*seasonlanding-link-pretitle[^>]*>([\s\S]*?)<\/p>/g;
  const headingRegex = /<h2[^>]*seasonlanding-link-heading[^>]*>([\s\S]*?)<\/h2>/g;

  const pretitles = [];
  const headings = [];
  let m;
  while ((m = pretitleRegex.exec(html)) !== null) {
    pretitles.push(m[1]);
  }
  while ((m = headingRegex.exec(html)) !== null) {
    headings.push(m[1]);
  }

  if (headings.length === 0) {
    console.warn(`  ⚠ No production cards found on ${seasonSlug} season page — check HTML structure`);
    return [];
  }

  const productions = [];
  for (let i = 0; i < headings.length; i++) {
    const rawTitle = headings[i]
      .replace(/<[^>]+>/g, ' ')         // strip tags
      .replace(/\\r\\n|\\r|\\n/g, ' ')  // literal escape sequences from JSON-encoded HTML
      .replace(/[\r\n\t]/g, ' ')        // actual control characters
      .replace(/\s+/g, ' ')
      .trim();
    // Strip the trailing CTA text
    const title = rawTitle
      .replace(/Buy Tickets.*$/i, '')
      .replace(/is not on sale.*$/i, '')
      .trim();

    if (!title || title.length < 2) continue;
    if (isNonOpera(title)) {
      if (title.length > 3) console.log(`  skip non-opera: ${title}`);
      continue;
    }

    // Extract date range and isNewProduction from pretitle block
    const pretitle = pretitles[i] || '';
    const isNewProduction = /New Production/i.test(pretitle);

    // Find date range: look for "Mon DD - Mon DD" or "Mon DD" pattern
    const dateRaw = (pretitle.match(/([A-Za-z]{3}\s+\d{1,2}\s*[-–]\s*[A-Za-z]{3}\s+\d{1,2})/) ||
                     pretitle.match(/([A-Za-z]{3}\s+\d{1,2})/))?.[1] || null;
    const { start, end } = parseDateRange(dateRaw, firstYear);

    productions.push({
      title,
      openingDate: start,
      closingDate: end,
      isNewProduction,
      seasonSlug,
    });
  }

  return productions;
}

// ─── shows.json helpers ──────────────────────────────────────────────────────
// Keep the exact object showsWriteGuard.loadShows() returned so saveShows()
// below passes back the SAME reference — the guard tracks snapshots by
// object identity (WeakMap) to merge concurrent writers' changes; handing it
// a freshly-built { _meta, shows } object would miss that lookup and fall
// back to an unmerged overwrite.
let loadedData = null;

function loadShows() {
  loadedData = showsWriteGuard.loadShows();
  return { meta: loadedData._meta, shows: loadedData.shows };
}

function saveShows(meta, shows) {
  if (loadedData) {
    loadedData._meta = meta;
    loadedData.shows = shows;
    showsWriteGuard.saveShows(loadedData);
  } else {
    showsWriteGuard.saveShows({ _meta: meta, shows });
  }
}

function operaIdPrefixes() {
  const src = fs.readFileSync(OPERA_IDS_FILE, 'utf8');
  const m = src.match(/new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return new Set();
  return new Set(m[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || []);
}

function addOperaIdPrefix(prefix) {
  let src = fs.readFileSync(OPERA_IDS_FILE, 'utf8');
  // Find the Set literal and append the new prefix before the closing bracket
  src = src.replace(
    /(new Set\(\[[\s\S]*?)(,?\s*\]\))/,
    (_, body, tail) => `${body},\n  '${prefix}'${tail}`
  );
  fs.writeFileSync(OPERA_IDS_FILE, src);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const { meta, shows } = loadShows();
  const existingIds = new Set(shows.map(s => s.id));
  const existingPrefixes = operaIdPrefixes();

  const toAdd = [];

  for (const seasonSlug of SEASONS) {
    let html;
    try {
      html = await scrapeSeasonPage(seasonSlug);
    } catch (e) {
      console.error(`  ✗ Failed to fetch ${seasonSlug}: ${e.message}`);
      continue;
    }

    const productions = parseSeasonProductions(html, seasonSlug);
    console.log(`  Found ${productions.length} opera productions in ${seasonSlug}`);

    for (const prod of productions) {
      const openingYear = prod.openingDate
        ? parseInt(prod.openingDate.slice(0, 4), 10)
        : parseInt(seasonSlug.split('-')[0], 10);

      const id = buildShowId(prod.title, openingYear);
      const idPrefix = buildIdPrefix(prod.title);
      const status = deriveStatus(prod.openingDate, prod.closingDate);

      if (existingIds.has(id)) {
        console.log(`  already in DB: ${id}`);
        continue;
      }

      const showEntry = {
        id,
        title: prod.title,
        slug: `${slugify(prod.title)}-off-broadway-${openingYear}`,
        venue: 'Metropolitan Opera House',
        openingDate: prod.openingDate,
        closingDate: prod.closingDate,
        status,
        type: 'opera',
        runtime: null,
        intermissions: null,
        images: {},
        synopsis: '',
        ageRecommendation: null,
        previewsStartDate: null,
        tags: prod.isNewProduction ? ['new'] : [],
        theaterAddress: null,
        ticketLinks: [],
        cast: [],
        creativeTeam: [],
        category: 'off-broadway',
        market: 'broadway',
      };

      toAdd.push({ showEntry, idPrefix, seasonSlug });
      existingIds.add(id); // prevent duplicates across seasons (e.g. La Bohème in both)
    }
  }

  if (toAdd.length === 0) {
    console.log('\n✓ No new opera shows to add — database is up to date.');
    return;
  }

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Found ${toAdd.length} new shows to add:\n`);
  for (const { showEntry, idPrefix } of toAdd) {
    const newPrefix = existingPrefixes.has(idPrefix) ? '' : ' (new ID prefix)';
    console.log(`  + ${showEntry.id}  [${showEntry.status}]  ${showEntry.openingDate || 'no date'} – ${showEntry.closingDate || '?'}${newPrefix}`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No files written.');
    return;
  }

  // Write shows
  const updatedShows = [...shows, ...toAdd.map(t => t.showEntry)];
  saveShows(meta, updatedShows);
  console.log(`\n✓ Wrote ${toAdd.length} shows to shows.json`);

  // Update opera-show-ids.ts
  let newPrefixCount = 0;
  for (const { idPrefix } of toAdd) {
    if (!existingPrefixes.has(idPrefix)) {
      addOperaIdPrefix(idPrefix);
      existingPrefixes.add(idPrefix);
      newPrefixCount++;
    }
  }
  if (newPrefixCount > 0) {
    console.log(`✓ Added ${newPrefixCount} new ID prefixes to opera-show-ids.ts`);
  }

  console.log('\nNext steps:');
  console.log('  1. node scripts/validate-data.js  — verify no schema errors');
  console.log('  2. Push shows.json to private repo  — CI picks up from there');
  console.log('  3. node scripts/gather-reviews.js --market=opera  — collect reviews for open shows');
}

if (require.main === module) {
  main()
    .catch(e => {
      console.error(e.stack || e.message);
      process.exit(1);
    })
    .finally(() => cleanup?.());
}

// Exports for unit tests / the audit-regex-patterns.js corpus audit (BRO-2315)
// — isNonOpera() gates which Met season-page titles ever reach shows.json, so
// it gets the same 0-hit-default FP audit as discover-new-shows.js's arrays.
module.exports = {
  NON_OPERA_TITLE_PATTERNS,
  isNonOpera,
};
