#!/usr/bin/env node
/**
 * Generate diary show data files for client-side diary/watchlist features.
 *
 * Reads data/diary-shows.json (from private repo) and data/mezzanine-productions-raw.json
 * to produce:
 *   - public/data/diary-search.json  — show-level search index with nested productions
 *   - public/data/diary-lookup.json  — for My Shows page display of diary-only shows
 *
 * diary-search.json groups productions by Mezzanine show ID so that searching
 * "Mary Poppins" returns one entry with 119 productions, not 119 separate results.
 *
 * Run: node scripts/generate-diary-data.js
 * Or via: npm run prebuild
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// Common prefix for Mezzanine poster URLs — stripped in output, reconstructed client-side
const MEZZ_IMG_PREFIX = 'https://www.theaterdiary.com/parse/files/C7TsezAg3jnX9jHLsC9KFEteyKePkwLtB46dDpfh/';

function compactPosterUrl(url) {
  if (!url) return undefined;
  if (url.startsWith(MEZZ_IMG_PREFIX)) return url.slice(MEZZ_IMG_PREFIX.length);
  return url;
}

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Load diary shows — graceful fallback if missing or empty
let diaryShows = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'diary-shows.json'), 'utf-8'));
  diaryShows = raw.shows || [];
} catch {
  // diary-shows.json doesn't exist yet — generate empty files
}

if (diaryShows.length === 0) {
  // Write empty files so fetches don't 404
  fs.writeFileSync(path.join(outputDir, 'diary-search.json'), '[]');
  fs.writeFileSync(path.join(outputDir, 'diary-lookup.json'), '[]');
  console.log('Generated empty diary data files (no diary shows yet)');
  process.exit(0);
}

// Load Mezzanine raw data to build production→show mapping
let mezzIdToShowId = {};
let mezzShowNames = {};
try {
  const mezzRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'mezzanine-productions-raw.json'), 'utf-8'));
  for (const p of mezzRaw) {
    const showObj = typeof p.show === 'object' ? p.show : null;
    if (showObj?.objectId) {
      mezzIdToShowId[p.objectId] = showObj.objectId;
      if (showObj.name && !mezzShowNames[showObj.objectId]) {
        mezzShowNames[showObj.objectId] = showObj.name;
      }
    }
  }
} catch {
  // If raw file unavailable, fall back to flat search (no grouping)
  console.warn('Warning: mezzanine-productions-raw.json not found, diary-search will not group productions');
}

const hasGrouping = Object.keys(mezzIdToShowId).length > 0;

// --- diary-search.json --- show-level search with nested productions

if (hasGrouping) {
  // Group diary shows by Mezzanine show ID
  const showGroups = {};
  let ungrouped = 0;

  for (const show of diaryShows) {
    const mezzShowId = mezzIdToShowId[show.mezzanineId];
    if (!mezzShowId) {
      // Treat as its own group (single production)
      ungrouped++;
      const key = '__ungrouped_' + show.id;
      showGroups[key] = {
        title: show.title,
        productions: [show],
      };
      continue;
    }
    if (!showGroups[mezzShowId]) {
      showGroups[mezzShowId] = {
        title: mezzShowNames[mezzShowId] || show.title,
        productions: [],
      };
    }
    showGroups[mezzShowId].productions.push(show);
  }

  // Build search entries — one per show group
  const searchEntries = Object.entries(showGroups).map(([groupId, group]) => {
    const prods = group.productions;
    // For single-production shows, keep it simple
    if (prods.length === 1) {
      const p = prods[0];
      const entry = {
        id: p.id,
        title: p.title,
        slug: p.slug,
        status: p.status || 'closed',
        dy: true,
      };
      if (p.venue) entry.venue = p.venue;
      if (p.city) entry.city = p.city;
      if (p.category && p.category !== 'broadway') entry.category = p.category;
      const cImg = compactPosterUrl(p.posterUrl);
      if (cImg) entry.img = cImg;
      return entry;
    }

    // Multi-production: nest productions array
    // Pick the "best" representative for status (any open > any previews > closed)
    const hasOpen = prods.some(p => p.status === 'open');
    const hasPreviews = prods.some(p => p.status === 'previews');
    const status = hasOpen ? 'open' : hasPreviews ? 'previews' : 'closed';

    // Pick best poster image (first available)
    const posterProd = prods.find(p => p.posterUrl);
    const img = compactPosterUrl(posterProd ? posterProd.posterUrl : undefined);

    // Classify regions for grouping
    const prodEntries = prods.map(p => {
      const entry = { id: p.id, v: p.venue || '', ci: p.city || '' };
      if (p.country) entry.co = p.country;
      if (p.openingDate) entry.y = p.openingDate.substring(0, 4);
      if (p.status === 'open') entry.st = 'open';
      if (p.category) entry.cat = p.category;
      return entry;
    });

    // Deduplicate productions with same venue+city (keep most recent year)
    // Normalize venue names: strip "The ", trailing "Theatre"/"Theater" variants, etc.
    function normalizeVenue(v, city) {
      let n = (v || '').toLowerCase()
        .replace(/^the\s+/, '')
        .replace(/\s+theatre$/, ' theater')
        .replace(/,\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
      // Strip city/region prefix from venue (e.g., "Sydney Lyric Theatre" → "lyric theater")
      // Try both the city field and common city names that appear as venue prefixes
      const prefixes = city ? [city.toLowerCase()] : [];
      // Add well-known city aliases for suburbs (e.g., Pyrmont is in Sydney)
      const suburbMap = { pyrmont: 'sydney', southwark: 'london', manhattan: 'new york' };
      if (city && suburbMap[city.toLowerCase()]) prefixes.push(suburbMap[city.toLowerCase()]);
      for (const prefix of prefixes) {
        if (n.startsWith(prefix + ' ')) { n = n.slice(prefix.length + 1); break; }
      }
      return n;
    }
    const seen = new Map();
    const dedupedEntries = [];
    for (const p of prodEntries) {
      const key = `${(p.ci || '').toLowerCase()}|${normalizeVenue(p.v, p.ci)}`;
      if (!key || key === '|') { dedupedEntries.push(p); continue; }
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, dedupedEntries.length);
        dedupedEntries.push(p);
      } else {
        // Keep the one with the most recent year, or open status
        const prev = dedupedEntries[existing];
        if (p.st === 'open' || (p.y && (!prev.y || p.y > prev.y))) {
          dedupedEntries[existing] = p;
        }
      }
    }

    // Sort: Broadway first, then West End, then by country, then city
    dedupedEntries.sort((a, b) => {
      const aIsBway = a.cat === 'broadway';
      const bIsBway = b.cat === 'broadway';
      if (aIsBway !== bIsBway) return aIsBway ? -1 : 1;
      const aIsWE = a.cat === 'west-end';
      const bIsWE = b.cat === 'west-end';
      if (aIsWE !== bIsWE) return aIsWE ? -1 : 1;
      // Then by country, city, year
      if (a.co !== b.co) return (a.co || '').localeCompare(b.co || '');
      if (a.ci !== b.ci) return (a.ci || '').localeCompare(b.ci || '');
      return (a.y || '').localeCompare(b.y || '');
    });

    const result = {
      gid: groupId, // group ID for multi-production
      title: group.title,
      status,
      dy: true,
      n: dedupedEntries.length, // production count (deduped by venue+city)
      prods: dedupedEntries,
    };
    if (img) result.img = img;
    return result;
  });

  const searchPath = path.join(outputDir, 'diary-search.json');
  fs.writeFileSync(searchPath, JSON.stringify(searchEntries));
  const searchSizeKB = (fs.statSync(searchPath).size / 1024).toFixed(0);

  const multiCount = searchEntries.filter(e => e.prods).length;
  console.log(`Generated diary-search.json: ${searchEntries.length} show groups (${multiCount} multi-production, ${searchSizeKB}KB)`);
  if (ungrouped > 0) console.log(`  ${ungrouped} shows could not be grouped (no Mezzanine show mapping)`);
} else {
  // Fallback: flat list (no grouping)
  const searchEntries = diaryShows.map(show => {
    const entry = {
      id: show.id,
      title: show.title,
      slug: show.slug,
      status: show.status || 'closed',
      dy: true,
    };
    if (show.venue) entry.venue = show.venue;
    if (show.category && show.category !== 'broadway') entry.category = show.category;
    return entry;
  });

  const searchPath = path.join(outputDir, 'diary-search.json');
  fs.writeFileSync(searchPath, JSON.stringify(searchEntries));
  const searchSizeKB = (fs.statSync(searchPath).size / 1024).toFixed(0);
  console.log(`Generated diary-search.json: ${searchEntries.length} shows FLAT (${searchSizeKB}KB, no grouping)`);
}

// --- diary-lookup.json --- compact format matching show-lookup.json structure
// Unchanged: one entry per production (needed for displaying user's specific production)
const lookupEntries = diaryShows.map(show => {
  const entry = { id: show.id, t: show.title, s: show.slug, v: show.venue || '', dy: 1 };
  if (show.category) entry.c = show.category;
  if (show.openingDate) entry.od = show.openingDate;
  const cImg = compactPosterUrl(show.posterUrl);
  if (cImg) entry.img = cImg;
  return entry;
});

const lookupPath = path.join(outputDir, 'diary-lookup.json');
fs.writeFileSync(lookupPath, JSON.stringify(lookupEntries));
const lookupSizeKB = (fs.statSync(lookupPath).size / 1024).toFixed(0);

console.log(`Generated diary-lookup.json: ${lookupEntries.length} productions (${lookupSizeKB}KB)`);
