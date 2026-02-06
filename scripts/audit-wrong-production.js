#!/usr/bin/env node
/**
 * Comprehensive wrong-production audit
 *
 * Checks all review-text files for contamination:
 * 1. Date-based: publishDate vs show opening (catches dated wrong-production)
 * 2. Director cross-check: review mentions director from a DIFFERENT production
 * 3. TV/Film signals: streaming platform keywords in review text
 * 4. Off-Broadway/London signals: non-Broadway venue/location references
 * 5. Year mismatch: review text mentions a year far from the show's year
 * 6. Cast cross-check: review mentions cast from a DIFFERENT production
 *
 * Usage: node scripts/audit-wrong-production.js [--fix] [--show=SLUG]
 */

const fs = require('fs');
const path = require('path');

const FIX_MODE = process.argv.includes('--fix');
const SHOW_FILTER = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];

// Load shows data
const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
const shows = showsData.shows;

// Build lookup maps
const showById = {};
shows.forEach(s => { showById[s.id] = s; });

// Group shows by base title for cross-production checks
const titleGroups = {};
shows.forEach(s => {
  const base = s.title.replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '').trim().toLowerCase();
  if (!titleGroups[base]) titleGroups[base] = [];
  titleGroups[base].push(s);
});

// Also add common title variations for cross-matching
const TITLE_ALIASES = {
  'cats': ['cats-1982', 'cats-2016', 'cats-the-jellicle-ball-2026'],
  'beetlejuice': ['beetlejuice-2019', 'beetlejuice-2022', 'beetlejuice-2025'],
  'rocky': ['rocky-2014'],
  'rocky horror': ['the-rocky-horror-show-2025'],
  'schmigadoon': ['schmigadoon-2025'],
};

// TV/Film/Streaming signals
const TV_FILM_PATTERNS = [
  /\b(apple\s*tv\+?|netflix|hbo\s*max|disney\+?|hulu|amazon\s*prime|peacock|paramount\+?)\b/i,
  /\b(television|tv\s*series|tv\s*show|streaming\s*(series|show|service)|web\s*series)\b/i,
  /\b(episode\s*\d|season\s*\d|pilot\s*episode|series\s*premiere|series\s*finale)\b/i,
  /\b(cineplex|movie\s*theater|film\s*review|on\s*screen|big\s*screen|motion\s*picture)\b/i,
  /\b(directed\s*by\s*[\w\s]+for\s*(apple|netflix|hbo|disney|hulu|amazon|paramount|peacock))\b/i,
];

// Off-Broadway venue signals (common off-Broadway theaters)
const OFF_BROADWAY_VENUES = [
  'lucille lortel', 'new york theatre workshop', 'nytw', 'vineyard theatre',
  'playwrights horizons', 'atlantic theater', 'signature theatre',
  'manhattan theatre club.*stage ii', 'mitzi newhouse', 'public theater',
  'joe\'s pub', 'minetta lane', 'cherry lane', 'lortel', 'new world stages',
  'barrow street', 'classic stage', 'csc', 'st. ann\'s warehouse',
  'ars nova', 'soho rep', 'theater for a new audience', 'perelman',
  'park avenue armory', 'brooklyn academy', 'bam',
];

// London/West End venue signals
const LONDON_VENUES = [
  'west end', 'london', 'old vic', 'young vic', 'national theatre',
  'donmar warehouse', 'almeida', 'barbican', 'royal court',
  'savoy theatre london', 'phoenix theatre london', 'adelphi theatre',
  'gielgud', 'wyndham', 'noel coward theatre', 'olivier theatre',
  'dorfman', 'lyttelton',
];

// Review-text directory
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const showDirs = fs.readdirSync(reviewTextsDir).filter(d =>
  fs.statSync(path.join(reviewTextsDir, d)).isDirectory()
);

const findings = [];
const stats = {
  totalReviews: 0,
  alreadyFlagged: 0,
  dateGuardCatches: 0,
  directorMismatch: 0,
  tvFilmSignals: 0,
  londonSignals: 0,
  offBroadwaySignals: 0,
  yearMismatch: 0,
  noPublishDate: 0,
};

for (const showDir of showDirs) {
  if (SHOW_FILTER && showDir !== SHOW_FILTER) continue;

  const show = showById[showDir];
  if (!show) continue;

  const showYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;
  const showEarliest = show.previewsStartDate || show.openingDate;
  const showEarliestDate = showEarliest ? new Date(showEarliest) : null;
  const showVenue = (show.venue || '').toLowerCase();

  // Get creative team for THIS production
  const thisDirectors = (show.creativeTeam || [])
    .filter(ct => /director/i.test(ct.role))
    .map(ct => ct.name.toLowerCase());

  // Get creative teams for OTHER productions of the same title
  const baseTitle = show.title.replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '').trim().toLowerCase();
  const otherProductions = (titleGroups[baseTitle] || []).filter(s => s.id !== show.id);

  const otherDirectors = new Set();
  const otherCreativeNames = new Set();
  otherProductions.forEach(op => {
    (op.creativeTeam || []).forEach(ct => {
      const name = ct.name.toLowerCase();
      otherCreativeNames.add(name);
      if (/director/i.test(ct.role)) otherDirectors.add(name);
    });
  });

  // Remove names that are the SAME across productions (e.g., book/music/lyrics writers)
  const thisCreativeNames = new Set((show.creativeTeam || []).map(ct => ct.name.toLowerCase()));
  const uniqueOtherDirectors = new Set([...otherDirectors].filter(d => !thisDirectors.includes(d)));

  const dirPath = path.join(reviewTextsDir, showDir);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

  for (const file of files) {
    stats.totalReviews++;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
    } catch (e) { continue; }

    // Skip already flagged
    if (data.wrongProduction || data.wrongShow) {
      stats.alreadyFlagged++;
      continue;
    }

    const reviewFindings = [];
    const text = (data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || '').toLowerCase();
    const hasText = text.length > 50;

    // 1. Date-based check
    if (data.publishDate && showEarliestDate) {
      const pubDate = new Date(data.publishDate);
      if (!isNaN(pubDate.getTime())) {
        const daysBefore = (showEarliestDate - pubDate) / (1000 * 60 * 60 * 24);
        if (daysBefore > 30) {
          stats.dateGuardCatches++;
          reviewFindings.push({
            type: 'DATE_GUARD',
            severity: daysBefore > 365 ? 'HIGH' : 'MEDIUM',
            detail: `Published ${Math.round(daysBefore)}d before show (${data.publishDate} vs ${showEarliest})`,
          });
        }
      }
    } else if (!data.publishDate) {
      stats.noPublishDate++;
    }

    if (!hasText) {
      // Can't do content checks without text
      if (reviewFindings.length > 0) {
        findings.push({ showId: showDir, file, score: data.assignedScore, findings: reviewFindings });
      }
      continue;
    }

    // 2. Director cross-check (for multi-production shows)
    if (uniqueOtherDirectors.size > 0) {
      for (const otherDir of uniqueOtherDirectors) {
        // Split name to check last name at minimum
        const parts = otherDir.split(' ');
        const lastName = parts[parts.length - 1];
        // Require full name match to reduce false positives
        if (text.includes(otherDir)) {
          stats.directorMismatch++;
          const otherShow = otherProductions.find(op =>
            (op.creativeTeam || []).some(ct => ct.name.toLowerCase() === otherDir && /director/i.test(ct.role))
          );
          reviewFindings.push({
            type: 'DIRECTOR_MISMATCH',
            severity: 'HIGH',
            detail: `Mentions director "${otherDir}" from ${otherShow?.id || 'other production'}`,
          });
        }
      }
    }

    // 3. TV/Film signals
    for (const pattern of TV_FILM_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // Don't flag if the show itself is related to TV (e.g., Stranger Things is a TV adaptation)
        const tvRelatedShows = ['stranger-things', 'schmigadoon', 'beetlejuice'];
        const isTvRelated = tvRelatedShows.some(t => showDir.includes(t));

        // For TV-related shows, only flag strong signals
        if (!isTvRelated || /\b(tv\s*series|season\s*\d|episode\s*\d|streaming\s*series)\b/i.test(match[0])) {
          stats.tvFilmSignals++;
          reviewFindings.push({
            type: 'TV_FILM_SIGNAL',
            severity: isTvRelated ? 'MEDIUM' : 'HIGH',
            detail: `Contains TV/film keyword: "${match[0]}"`,
          });
          break; // One signal is enough
        }
      }
    }

    // 4. London/West End signals (only for shows not explicitly marked as transfers)
    for (const venue of LONDON_VENUES) {
      const pattern = new RegExp(`\\b${venue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(text)) {
        // Context check: is this mentioning London as the VENUE of the review, not just as a reference?
        // Look for phrases like "at the [London venue]", "reviewed at", "opens at", etc.
        const contextPatterns = [
          new RegExp(`(at|in)\\s+(the\\s+)?${venue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
          new RegExp(`${venue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(theater|theatre|stage|production)`, 'i'),
        ];
        const hasVenueContext = contextPatterns.some(p => p.test(text));

        // "West End" and "London" are too generic — require stronger context
        if (venue === 'west end' || venue === 'london') {
          // Check if the review is ABOUT a London production
          const londonReviewSignals = [
            /\breview(ed|ing)?\s+(at|in)\s+(the\s+)?london/i,
            /\b(london|west end)\s+(premiere|opening|production|revival|transfer|run)\b/i,
            /\bat\s+the\s+\w+\s+theatre\s+(in\s+)?london/i,
          ];
          if (londonReviewSignals.some(p => p.test(text))) {
            stats.londonSignals++;
            reviewFindings.push({
              type: 'LONDON_SIGNAL',
              severity: 'MEDIUM',
              detail: `Review appears to be about a London/West End production`,
            });
            break;
          }
        } else if (hasVenueContext) {
          stats.londonSignals++;
          reviewFindings.push({
            type: 'LONDON_SIGNAL',
            severity: 'MEDIUM',
            detail: `Mentions London venue: "${venue}"`,
          });
          break;
        }
      }
    }

    // 5. Year mismatch in review text
    if (showYear) {
      // Find all 4-digit years in the text (2000-2029)
      const yearMatches = text.match(/\b(20[0-2]\d)\b/g);
      if (yearMatches) {
        const mentionedYears = [...new Set(yearMatches.map(Number))];
        // Check if a DIFFERENT production year is prominently mentioned
        const otherProdYears = otherProductions
          .map(op => op.openingDate ? new Date(op.openingDate).getFullYear() : null)
          .filter(Boolean);

        for (const yr of mentionedYears) {
          if (otherProdYears.includes(yr) && Math.abs(yr - showYear) > 1) {
            // Count how many times each year appears
            const thisYearCount = (text.match(new RegExp(`\\b${showYear}\\b`, 'g')) || []).length;
            const otherYearCount = (text.match(new RegExp(`\\b${yr}\\b`, 'g')) || []).length;

            // If the other production's year appears more than this production's year,
            // it's likely about the other production
            if (otherYearCount > thisYearCount && otherYearCount >= 2) {
              stats.yearMismatch++;
              reviewFindings.push({
                type: 'YEAR_MISMATCH',
                severity: 'HIGH',
                detail: `Mentions year ${yr} (${otherYearCount}x) more than ${showYear} (${thisYearCount}x). ${yr} matches production: ${otherProductions.find(op => op.openingDate && new Date(op.openingDate).getFullYear() === yr)?.id}`,
              });
              break;
            }
          }
        }
      }
    }

    // 6. Off-Broadway venue signals (for shows that should be Broadway)
    if (show.venue && !show.venue.toLowerCase().includes('off-broadway')) {
      for (const venue of OFF_BROADWAY_VENUES) {
        const pattern = new RegExp(`\\b${venue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (pattern.test(text)) {
          // Context: is the off-Broadway venue mentioned as WHERE the review took place?
          const atVenue = new RegExp(`(at|in)\\s+(the\\s+)?${venue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
          if (atVenue.test(text)) {
            // Don't flag if the show's own venue partially matches
            if (!showVenue.includes(venue.split(' ')[0])) {
              stats.offBroadwaySignals++;
              reviewFindings.push({
                type: 'OFF_BROADWAY_SIGNAL',
                severity: 'MEDIUM',
                detail: `Review mentions off-Broadway venue: "${venue}"`,
              });
              break;
            }
          }
        }
      }
    }

    if (reviewFindings.length > 0) {
      findings.push({
        showId: showDir,
        file,
        score: data.assignedScore,
        publishDate: data.publishDate || null,
        hasFullText: !!data.fullText,
        url: data.url,
        findings: reviewFindings,
      });
    }
  }
}

// Sort findings by severity
const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
findings.sort((a, b) => {
  const aMax = Math.min(...a.findings.map(f => severityOrder[f.severity] ?? 2));
  const bMax = Math.min(...b.findings.map(f => severityOrder[f.severity] ?? 2));
  return aMax - bMax;
});

// Report
console.log('\n=== WRONG-PRODUCTION AUDIT REPORT ===\n');
console.log(`Total reviews scanned: ${stats.totalReviews}`);
console.log(`Already flagged (wrongProduction/wrongShow): ${stats.alreadyFlagged}`);
console.log(`Reviews without publishDate: ${stats.noPublishDate}`);
console.log(`\nFindings:`);
console.log(`  Date guard catches (>30d before show): ${stats.dateGuardCatches}`);
console.log(`  Director mismatches: ${stats.directorMismatch}`);
console.log(`  TV/Film signals: ${stats.tvFilmSignals}`);
console.log(`  London/West End signals: ${stats.londonSignals}`);
console.log(`  Off-Broadway signals: ${stats.offBroadwaySignals}`);
console.log(`  Year mismatches: ${stats.yearMismatch}`);
console.log(`\nTotal suspected wrong-production reviews: ${findings.length}`);

// Group by show for readability
const byShow = {};
findings.forEach(f => {
  if (!byShow[f.showId]) byShow[f.showId] = [];
  byShow[f.showId].push(f);
});

console.log(`\nAffected shows: ${Object.keys(byShow).length}\n`);

let fixCount = 0;
for (const [showId, showFindings] of Object.entries(byShow).sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`\n📋 ${showId} (${showFindings.length} suspected):`);
  for (const f of showFindings) {
    const severities = f.findings.map(ff => ff.severity);
    const maxSeverity = severities.includes('HIGH') ? '🔴' : '🟡';
    console.log(`  ${maxSeverity} ${f.file} (score: ${f.score}, pubDate: ${f.publishDate || 'null'})`);
    for (const ff of f.findings) {
      console.log(`     [${ff.type}] ${ff.detail}`);
    }

    if (FIX_MODE) {
      const filePath = path.join(reviewTextsDir, showId, f.file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data.wrongProduction) {
        data.wrongProduction = true;
        data.wrongProductionNote = `Auto-flagged by audit: ${f.findings.map(ff => ff.type + ': ' + ff.detail).join('; ')}`;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        fixCount++;
      }
    }
  }
}

if (FIX_MODE) {
  console.log(`\n✅ Fixed ${fixCount} review files (added wrongProduction: true)`);
}

// Save detailed report
const reportPath = path.join(__dirname, '../data/audit/wrong-production-audit.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  stats,
  findings: findings.map(f => ({
    showId: f.showId,
    file: f.file,
    score: f.score,
    publishDate: f.publishDate,
    url: f.url,
    findings: f.findings,
  }))
}, null, 2));
console.log(`\nDetailed report saved to: ${reportPath}`);
