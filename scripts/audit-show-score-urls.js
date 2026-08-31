#!/usr/bin/env node
/**
 * audit-show-score-urls.js
 *
 * Audits show-score-urls.json for wrong-production matches by:
 * 1. Checking for duplicate URLs (multiple shows → same URL)
 * 2. Cross-referencing review dates in archived pages against production dates
 * 3. Extracting venue from meta description where available
 * 4. Flagging multi-production shows with generic URLs
 *
 * Usage:
 *   node scripts/audit-show-score-urls.js [--verbose]
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { venuesMatch } = require('./lib/deduplication');

const DATA_DIR = path.join(__dirname, '../data');
const URLS_PATH = path.join(DATA_DIR, 'show-score-urls.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'aggregator-archive/show-score');

const verbose = process.argv.includes('--verbose');

const urlData = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = showsData.shows || showsData;
const showMap = {};
for (const s of shows) showMap[s.id] = s;

function extractYearFromId(id) {
  const m = id.match(/-(\d{4})$/);
  return m ? parseInt(m[1]) : null;
}

function extractVenueFromMeta(html) {
  try {
    const $ = cheerio.load(html);
    const desc = $('meta[name="description"]').attr('content') || '';
    const cleaned = desc.replace(/&nbsp;/g, ' ');
    const m = cleaned.match(/\bat\s+(.+?)\.?\s*$/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function extractPageProductionYear(html) {
  try {
    const $ = cheerio.load(html);
    const title = $('title').text() || '';
    const yearMatch = title.match(/\((?:Broadway|Off-Broadway|London)?\s*(\d{4})\)/i);
    if (yearMatch) return parseInt(yearMatch[1]);
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const ogMatch = ogTitle.match(/\((?:Broadway|Off-Broadway|London)?\s*(\d{4})\)/i);
    if (ogMatch) return parseInt(ogMatch[1]);
    return null;
  } catch { return null; }
}

function extractReviewDates(html) {
  try {
    const dates = [];
    const datePattern = /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4}/gi;
    const matches = html.match(datePattern) || [];
    for (const m of matches) {
      const d = new Date(m);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2030) {
        dates.push(d);
      }
    }
    return dates.sort((a, b) => a - b);
  } catch { return []; }
}

// Build multi-production map
const productionsByBase = {};
for (const s of shows) {
  const base = s.id.replace(/-\d{4}$/, '');
  if (!productionsByBase[base]) productionsByBase[base] = [];
  productionsByBase[base].push(s);
}
const multiProductionBases = new Set(
  Object.entries(productionsByBase).filter(([_, p]) => p.length > 1).map(([b]) => b)
);

const results = { confirmed_wrong: [], duplicate_url: [], suspicious: [], ok: [], no_archive: [] };

// Check 1: Duplicate URLs
const urlToIds = {};
for (const [id, url] of Object.entries(urlData.shows)) {
  if (!urlToIds[url]) urlToIds[url] = [];
  urlToIds[url].push(id);
}
for (const [url, ids] of Object.entries(urlToIds)) {
  if (ids.length > 1) results.duplicate_url.push({ url, showIds: ids });
}

// Check 2: Per-show audit
for (const [showId, url] of Object.entries(urlData.shows)) {
  const show = showMap[showId];
  if (!show) continue;

  const archivePath = path.join(ARCHIVE_DIR, `${showId}.html`);
  if (!fs.existsSync(archivePath)) {
    const base = showId.replace(/-\d{4}$/, '');
    if (extractYearFromId(showId) && multiProductionBases.has(base)) {
      results.suspicious.push({
        showId, url,
        reason: `No archive to verify, multi-production show (${productionsByBase[base].length} productions)`,
        venue: show.venue, status: show.status,
      });
    } else {
      results.no_archive.push({ showId, url });
    }
    continue;
  }

  const html = fs.readFileSync(archivePath, 'utf8');
  const issues = [];

  // Check year mismatch
  const pageYear = extractPageProductionYear(html);
  const showYear = extractYearFromId(showId);
  if (pageYear && showYear && Math.abs(pageYear - showYear) > 1) {
    issues.push(`Page says ${pageYear}, show is ${showYear}`);
  }

  // Check review dates
  const reviewDates = extractReviewDates(html);
  if (reviewDates.length >= 3) {
    const earliest = reviewDates[0];
    const latest = reviewDates[reviewDates.length - 1];
    const startRef = show.previewsStartDate ? new Date(show.previewsStartDate) : show.openingDate ? new Date(show.openingDate) : null;
    const closingDate = show.closingDate ? new Date(show.closingDate) : null;

    if (startRef && earliest < new Date(startRef.getTime() - 365 * 86400000)) {
      issues.push(`Earliest review ${earliest.toISOString().split('T')[0]} is >1yr before previews ${startRef.toISOString().split('T')[0]}`);
    }
    if (closingDate && latest > new Date(closingDate.getTime() + 180 * 86400000)) {
      issues.push(`Latest review ${latest.toISOString().split('T')[0]} is >6mo after closing ${closingDate.toISOString().split('T')[0]}`);
    }
    const medianDate = reviewDates[Math.floor(reviewDates.length / 2)];
    if (showYear && Math.abs(medianDate.getFullYear() - showYear) > 2) {
      issues.push(`Median review year ${medianDate.getFullYear()} differs from show year ${showYear} by >2 years`);
    }
  }

  // Check venue (multi-production only)
  const pageVenue = extractVenueFromMeta(html);
  if (pageVenue && show.venue && !venuesMatch(pageVenue, show.venue)) {
    const base = showId.replace(/-\d{4}$/, '');
    if (multiProductionBases.has(base)) {
      issues.push(`Page venue "${pageVenue}" != show venue "${show.venue}"`);
    }
  }

  if (issues.length > 0) {
    results.confirmed_wrong.push({
      showId, url,
      show: { title: show.title, venue: show.venue, status: show.status, openingDate: show.openingDate, closingDate: show.closingDate },
      pageYear, pageVenue,
      reviewDateRange: reviewDates.length >= 3
        ? `${reviewDates[0].toISOString().split('T')[0]} — ${reviewDates[reviewDates.length - 1].toISOString().split('T')[0]} (${reviewDates.length} dates)`
        : `${reviewDates.length} dates found`,
      issues,
    });
  } else {
    const base = showId.replace(/-\d{4}$/, '');
    results.ok.push({ showId, url, note: multiProductionBases.has(base) ? `multi-production (${productionsByBase[base].length}), dates OK` : undefined });
  }
}

// Report
console.log('═══════════════════════════════════════════════════');
console.log('  Show Score URL Audit Report');
console.log('═══════════════════════════════════════════════════\n');

if (results.duplicate_url.length > 0) {
  console.log(`DUPLICATE URLs (${results.duplicate_url.length}):`);
  results.duplicate_url.forEach(d => {
    console.log(`  ${d.url}`);
    d.showIds.forEach(id => {
      const s = showMap[id];
      console.log(`    → ${id} (${s?.status || '?'}, ${s?.venue || 'no venue'}, opens ${s?.openingDate || '?'})`);
    });
  });
  console.log('');
}

if (results.confirmed_wrong.length > 0) {
  console.log(`CONFIRMED WRONG PRODUCTION (${results.confirmed_wrong.length}):`);
  results.confirmed_wrong.forEach(r => {
    console.log(`  ${r.showId}:`);
    console.log(`    URL: ${r.url}`);
    console.log(`    Show: ${r.show.title} @ ${r.show.venue} (${r.show.status}, opens ${r.show.openingDate})`);
    if (r.pageYear) console.log(`    Page year: ${r.pageYear}`);
    if (r.pageVenue) console.log(`    Page venue: ${r.pageVenue}`);
    console.log(`    Review dates: ${r.reviewDateRange}`);
    r.issues.forEach(i => console.log(`    ! ${i}`));
    console.log('');
  });
}

if (results.suspicious.length > 0) {
  console.log(`SUSPICIOUS — no archive to verify (${results.suspicious.length}):`);
  const shown = verbose ? results.suspicious : results.suspicious.slice(0, 10);
  shown.forEach(r => console.log(`  ${r.showId} (${r.status}, ${r.venue}): ${r.reason}`));
  if (!verbose && results.suspicious.length > 10) console.log(`  ... and ${results.suspicious.length - 10} more (use --verbose)`);
  console.log('');
}

console.log('Summary:');
console.log(`  Duplicate URLs:       ${results.duplicate_url.length}`);
console.log(`  Confirmed wrong:      ${results.confirmed_wrong.length}`);
console.log(`  Suspicious (no arch): ${results.suspicious.length}`);
console.log(`  OK:                   ${results.ok.length}`);
console.log(`  No archive:           ${results.no_archive.length}`);
console.log(`  Total checked:        ${Object.keys(urlData.shows).length}`);
