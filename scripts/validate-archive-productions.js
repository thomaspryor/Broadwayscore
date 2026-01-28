#!/usr/bin/env node

/**
 * Validate Archive Productions
 *
 * Checks that archived aggregator pages match the expected production year/venue.
 * This prevents issues where we accidentally archived a different revival or
 * tour production instead of the intended Broadway production.
 *
 * Checks:
 * 1. DTLI archives - looks for opening date, theater name in page
 * 2. BWW archives - looks for year references matching show ID
 * 3. Show Score archives - verifies broadway-shows URL (not off-broadway)
 *
 * Usage: node scripts/validate-archive-productions.js [--fix]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'aggregator-archive');

// Load shows data
const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const shows = showsData.shows || showsData;
const showsById = {};
shows.forEach(s => showsById[s.id] = s);

const results = {
  checked: 0,
  valid: 0,
  mismatches: [],
  warnings: [],
  errors: []
};

console.log('=== Validate Archive Productions ===\n');

/**
 * Extract year from show ID (e.g., "our-town-2024" -> 2024)
 */
function getYearFromId(showId) {
  const match = showId.match(/-(\d{4})$/);
  return match ? parseInt(match[1]) : null;
}

/**
 * Validate DTLI archive
 */
function validateDtliArchive(showId, htmlPath) {
  const show = showsById[showId];
  if (!show) {
    results.warnings.push({ showId, source: 'dtli', issue: 'Show not found in shows.json' });
    return;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const expectedYear = getYearFromId(showId);
  const expectedVenue = show.venue?.toLowerCase() || '';
  const openingDate = show.openingDate;

  // Extract info from DTLI page
  // DTLI format: "Opening Night:&nbsp;<span...>December 4, 2002</span>"
  // and "Theater: <a...>Booth Theatre</a>"
  const openingMatch = html.match(/Opening Night[:\s]*(?:&nbsp;)?(?:<[^>]+>)?([A-Za-z]+\s+\d+,?\s+\d{4})/i);
  const theaterMatch = html.match(/Theater[:\s]*(?:<a[^>]+>)?([^<\n]+)/i);

  let pageYear = null;
  let pageTheater = null;

  if (openingMatch) {
    const dateStr = openingMatch[1];
    const yearMatch = dateStr.match(/\d{4}/);
    if (yearMatch) pageYear = parseInt(yearMatch[0]);
  }

  if (theaterMatch) {
    pageTheater = theaterMatch[1].trim().toLowerCase();
  }

  results.checked++;

  // Check for year mismatch (ignore 1970 which is Unix epoch placeholder for missing data)
  if (pageYear && pageYear !== 1970 && expectedYear && Math.abs(pageYear - expectedYear) > 1) {
    results.mismatches.push({
      showId,
      source: 'dtli',
      file: path.basename(htmlPath),
      expected: { year: expectedYear, venue: show.venue },
      found: { year: pageYear, theater: pageTheater },
      issue: `Year mismatch: expected ${expectedYear}, found ${pageYear}`
    });
    return;
  }

  // Check for obvious venue mismatch (if we have both)
  if (pageTheater && expectedVenue &&
      !pageTheater.includes(expectedVenue.split(' ')[0].toLowerCase()) &&
      !expectedVenue.includes(pageTheater.split(' ')[0])) {
    // Only flag if years also don't match or we're confident it's wrong
    if (pageYear && expectedYear && pageYear !== expectedYear) {
      results.mismatches.push({
        showId,
        source: 'dtli',
        file: path.basename(htmlPath),
        expected: { year: expectedYear, venue: show.venue },
        found: { year: pageYear, theater: pageTheater },
        issue: `Venue mismatch: expected ${show.venue}, found ${pageTheater}`
      });
      return;
    }
  }

  results.valid++;
}

/**
 * Validate BWW archive
 */
function validateBwwArchive(showId, htmlPath) {
  const show = showsById[showId];
  if (!show) {
    results.warnings.push({ showId, source: 'bww', issue: 'Show not found in shows.json' });
    return;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const expectedYear = getYearFromId(showId);

  results.checked++;

  // BWW roundups often have dates in the URL or article
  // Check for year mentions - look for the expected year vs other years
  const yearRegex = /\b(19\d{2}|20\d{2})\b/g;
  const yearsFound = new Set();
  let match;
  while ((match = yearRegex.exec(html)) !== null) {
    yearsFound.add(parseInt(match[1]));
  }

  // Check if expected year is present
  if (expectedYear && yearsFound.size > 0 && !yearsFound.has(expectedYear)) {
    // Check if this might be a different production year
    const otherProductionYears = [...yearsFound].filter(y =>
      y !== expectedYear &&
      y > 1990 && y < 2030 &&
      Math.abs(y - expectedYear) > 1
    );

    if (otherProductionYears.length > 0) {
      // Check title/URL for clues
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1] : '';

      // If title mentions a different year prominently, flag it
      for (const wrongYear of otherProductionYears) {
        if (title.includes(wrongYear.toString()) && !title.includes(expectedYear?.toString())) {
          results.mismatches.push({
            showId,
            source: 'bww',
            file: path.basename(htmlPath),
            expected: { year: expectedYear },
            found: { yearsInPage: [...yearsFound], titleYear: wrongYear },
            issue: `Possible wrong production: title mentions ${wrongYear}, expected ${expectedYear}`
          });
          return;
        }
      }
    }
  }

  // Check for Kennedy Center in TITLE (not just sidebar mentions)
  // BWW pages often have Kennedy Center ads in sidebar - ignore those
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].toLowerCase() : '';
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const pageH1 = h1Match ? h1Match[1].toLowerCase() : '';

  if ((pageTitle.includes('kennedy center') || pageH1.includes('kennedy center')) &&
      !show.venue?.toLowerCase().includes('kennedy')) {
    results.mismatches.push({
      showId,
      source: 'bww',
      file: path.basename(htmlPath),
      expected: { venue: show.venue || 'Broadway' },
      found: { title: pageTitle.trim() },
      issue: 'Page TITLE references Kennedy Center - this is a tour/tryout page, not Broadway'
    });
    return;
  }

  results.valid++;
}

/**
 * Validate Show Score archive
 */
function validateShowScoreArchive(showId, htmlPath) {
  const show = showsById[showId];
  if (!show) {
    results.warnings.push({ showId, source: 'show-score', issue: 'Show not found in shows.json' });
    return;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  results.checked++;

  // Check canonical URL - should be broadway-shows, not off-broadway
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (canonicalMatch) {
    const canonical = canonicalMatch[1];
    if (canonical.includes('/off-broadway-shows/') || canonical.includes('/off-off-broadway-shows/')) {
      results.mismatches.push({
        showId,
        source: 'show-score',
        file: path.basename(htmlPath),
        expected: { type: 'Broadway' },
        found: { canonical: canonical },
        issue: 'Canonical URL is off-Broadway/off-off-Broadway, not Broadway'
      });
      return;
    }
  }

  // Check for obvious production type indicators
  if (html.toLowerCase().includes('off-broadway') && !html.toLowerCase().includes('broadway-shows')) {
    results.warnings.push({
      showId,
      source: 'show-score',
      issue: 'Page mentions "off-broadway" - verify this is correct production'
    });
  }

  results.valid++;
}

// Process all archives
const dtliDir = path.join(ARCHIVE_DIR, 'dtli');
const bwwDir = path.join(ARCHIVE_DIR, 'bww-roundups');
const showScoreDir = path.join(ARCHIVE_DIR, 'show-score');

// DTLI archives
if (fs.existsSync(dtliDir)) {
  console.log('Checking DTLI archives...');
  const files = fs.readdirSync(dtliDir).filter(f => f.endsWith('.html'));
  for (const file of files) {
    const showId = file.replace('.html', '');
    validateDtliArchive(showId, path.join(dtliDir, file));
  }
}

// BWW archives
if (fs.existsSync(bwwDir)) {
  console.log('Checking BWW archives...');
  const files = fs.readdirSync(bwwDir).filter(f => f.endsWith('.html'));
  for (const file of files) {
    const showId = file.replace('.html', '');
    validateBwwArchive(showId, path.join(bwwDir, file));
  }
}

// Show Score archives
if (fs.existsSync(showScoreDir)) {
  console.log('Checking Show Score archives...');
  const files = fs.readdirSync(showScoreDir).filter(f => f.endsWith('.html'));
  for (const file of files) {
    const showId = file.replace('.html', '');
    validateShowScoreArchive(showId, path.join(showScoreDir, file));
  }
}

// Report results
console.log('\n=== Results ===\n');
console.log(`Checked: ${results.checked}`);
console.log(`Valid: ${results.valid}`);
console.log(`Mismatches: ${results.mismatches.length}`);
console.log(`Warnings: ${results.warnings.length}`);

if (results.mismatches.length > 0) {
  console.log('\n❌ MISMATCHES (need refetch):');
  results.mismatches.forEach(m => {
    console.log(`\n  ${m.showId} (${m.source}):`);
    console.log(`    File: ${m.file}`);
    console.log(`    Issue: ${m.issue}`);
    console.log(`    Expected: ${JSON.stringify(m.expected)}`);
    console.log(`    Found: ${JSON.stringify(m.found)}`);
  });
}

if (results.warnings.length > 0) {
  console.log('\n⚠️  WARNINGS (review manually):');
  results.warnings.forEach(w => {
    console.log(`  ${w.showId} (${w.source}): ${w.issue}`);
  });
}

// Save report
const reportPath = path.join(DATA_DIR, 'audit', 'archive-production-validation.json');
const reportDir = path.dirname(reportPath);
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

fs.writeFileSync(reportPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  summary: {
    checked: results.checked,
    valid: results.valid,
    mismatches: results.mismatches.length,
    warnings: results.warnings.length
  },
  mismatches: results.mismatches,
  warnings: results.warnings
}, null, 2));

console.log(`\n✅ Report saved to ${reportPath}`);

// Exit with error if mismatches found
if (results.mismatches.length > 0) {
  console.log('\n🔧 To fix, run:');
  const showsToFix = [...new Set(results.mismatches.map(m => m.showId))];
  console.log(`   gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=${showsToFix.join(',')} --field force=true`);
  process.exit(1);
}
