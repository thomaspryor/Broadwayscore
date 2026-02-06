#!/usr/bin/env node
/**
 * audit-cross-show-url-collisions.js — Find URLs that appear in multiple shows' review-texts.
 *
 * Phase B of the source cleanup plan. Generates a collision report with confidence levels,
 * and can auto-apply high-confidence fixes.
 *
 * Usage:
 *   node scripts/audit-cross-show-url-collisions.js                  # Report only
 *   node scripts/audit-cross-show-url-collisions.js --apply          # Apply high-confidence fixes
 *   node scripts/audit-cross-show-url-collisions.js --verbose        # Show details
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'audit', 'url-collision-report.json');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

function log(msg) { if (VERBOSE) console.log(msg); }

function normalizeUrl(url) {
  if (!url) return null;
  try {
    let u = url.trim().toLowerCase();
    // Strip trailing slash, hash, query params for comparison
    u = u.replace(/[#?].*$/, '').replace(/\/+$/, '');
    // Normalize http → https
    u = u.replace(/^http:\/\//, 'https://');
    // Strip www.
    u = u.replace(/^https:\/\/www\./, 'https://');
    return u || null;
  } catch { return null; }
}

function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

// Load show data for opening dates
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const showDateMap = {};
for (const s of showsData.shows) {
  showDateMap[s.id] = {
    openingDate: s.openingDate ? new Date(s.openingDate) : null,
    previewsStartDate: s.previewsStartDate ? new Date(s.previewsStartDate) : null,
    title: s.title,
  };
}

// Build global URL → file map
console.log('Scanning review-texts for cross-show URL collisions...\n');

const urlMap = new Map(); // normalizedUrl → [{showId, file, filePath, publishDate, hasScore, hasFullText, ...}]
let totalFiles = 0;
let skippedFlagged = 0;

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
  const stat = fs.statSync(path.join(REVIEW_TEXTS_DIR, d));
  return stat.isDirectory();
});

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    totalFiles++;
    const filePath = path.join(showDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { continue; }

    // Skip already-flagged files
    if (data.wrongProduction || data.wrongShow || data.isRoundupArticle || data.duplicateOf) {
      skippedFlagged++;
      continue;
    }

    const url = normalizeUrl(data.url);
    if (!url) continue;

    const entry = {
      showId,
      file,
      filePath,
      url: data.url, // original URL
      publishDate: data.publishDate || null,
      openingDate: showDateMap[showId]?.openingDate?.toISOString()?.substring(0, 10) || null,
      hasScore: !!(data.assignedScore || data.humanReviewScore),
      hasFullText: !!(data.fullText && data.fullText.length > 100),
      outletId: data.outletId,
      criticName: data.criticName,
      source: data.source,
    };

    if (!urlMap.has(url)) {
      urlMap.set(url, []);
    }
    urlMap.get(url).push(entry);
  }
}

// Find collisions (URLs in 2+ different shows)
const collisions = [];
for (const [url, entries] of urlMap) {
  const uniqueShows = new Set(entries.map(e => e.showId));
  if (uniqueShows.size < 2) continue;

  collisions.push({ url, candidates: entries });
}

console.log(`Files scanned:     ${totalFiles}`);
console.log(`Skipped (flagged): ${skippedFlagged}`);
console.log(`Unique URLs:       ${urlMap.size}`);
console.log(`Cross-show collisions: ${collisions.length}\n`);

// Analyze each collision
const results = [];
let highCount = 0, mediumCount = 0, lowCount = 0;

for (const collision of collisions) {
  const { url, candidates } = collision;

  // Determine confidence and suggested winner
  let suggestedWinner = null;
  let reason = '';
  let confidence = 'low';

  // Check publish date proximity to opening dates
  const withDates = candidates.filter(c => c.publishDate && c.openingDate);

  if (withDates.length > 0) {
    // Calculate days between publish and opening for each candidate
    const scored = withDates.map(c => {
      const pubDate = new Date(c.publishDate);
      const openDate = new Date(c.openingDate);
      const daysDiff = Math.abs((pubDate - openDate) / (1000 * 60 * 60 * 24));
      return { ...c, daysDiff };
    });

    // Sort by proximity
    scored.sort((a, b) => a.daysDiff - b.daysDiff);

    const closest = scored[0];
    const secondClosest = scored.length > 1 ? scored[1] : null;

    if (closest.daysDiff <= 60) {
      if (!secondClosest || secondClosest.daysDiff > 60) {
        // Only one candidate within 60 days
        confidence = 'high';
        suggestedWinner = closest.showId;
        reason = `publishDate ${closest.publishDate} is ${Math.round(closest.daysDiff)} days from ${closest.showId} opening (${closest.openingDate})`;
        if (secondClosest) {
          reason += `; next closest is ${Math.round(secondClosest.daysDiff)} days from ${secondClosest.showId}`;
        }
      } else {
        // Multiple candidates within 60 days
        confidence = 'medium';
        suggestedWinner = closest.showId;
        reason = `publishDate ${closest.publishDate} is ${Math.round(closest.daysDiff)} days from ${closest.showId} but also ${Math.round(secondClosest.daysDiff)} days from ${secondClosest.showId}`;
      }
    } else {
      // Publish date not close to any opening
      confidence = 'low';
      reason = `publishDate ${closest.publishDate} is ${Math.round(closest.daysDiff)}+ days from all openings`;
    }
  } else {
    // No publish dates at all — check if one candidate has score/fullText and others don't
    const withContent = candidates.filter(c => c.hasScore || c.hasFullText);
    if (withContent.length === 1) {
      confidence = 'medium';
      suggestedWinner = withContent[0].showId;
      reason = 'Only one candidate has score/fullText';
    } else {
      confidence = 'low';
      reason = 'No publish dates available, cannot determine correct show';
    }
  }

  // Secondary heuristic: if no publish date match, check which show has the review data
  if (confidence === 'low' && !suggestedWinner) {
    // Pick the candidate whose opening date is most recent (most likely to be the actual reviewed production)
    const withOpening = candidates.filter(c => c.openingDate);
    if (withOpening.length > 0) {
      withOpening.sort((a, b) => new Date(b.openingDate) - new Date(a.openingDate));
      suggestedWinner = withOpening[0].showId;
      reason += '; defaulting to most recent production';
    }
  }

  const result = {
    url: candidates[0].url, // original URL
    normalizedUrl: url,
    candidates: candidates.map(c => ({
      showId: c.showId,
      file: c.file,
      publishDate: c.publishDate,
      openingDate: c.openingDate,
      hasScore: c.hasScore,
      hasFullText: c.hasFullText,
      outletId: c.outletId,
    })),
    suggestedWinner,
    reason,
    confidence,
  };

  results.push(result);

  if (confidence === 'high') highCount++;
  else if (confidence === 'medium') mediumCount++;
  else lowCount++;

  log(`[${confidence}] ${url}`);
  log(`  Winner: ${suggestedWinner} — ${reason}`);
  candidates.forEach(c => log(`    ${c.showId}/${c.file} (pub:${c.publishDate || 'null'} open:${c.openingDate || 'null'} score:${c.hasScore} text:${c.hasFullText})`));
}

console.log('=== COLLISION ANALYSIS ===');
console.log(`High confidence:   ${highCount} (auto-fixable)`);
console.log(`Medium confidence:  ${mediumCount} (needs review)`);
console.log(`Low confidence:     ${lowCount} (report only)\n`);

// Write report
fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  summary: { total: results.length, high: highCount, medium: mediumCount, low: lowCount },
  collisions: results,
}, null, 2) + '\n');
console.log(`Report written to: ${REPORT_PATH}`);

// Apply fixes
if (APPLY) {
  let genericUrlsNulled = 0;
  let highConfFlagged = 0;
  let revivalScoreFlagged = 0;

  // --- Tier 0: Generic/homepage URLs (5+ shows sharing same URL → null URL on all) ---
  console.log('\n=== TIER 0: GENERIC/HOMEPAGE URLs ===');
  const GENERIC_THRESHOLD = 5; // URLs in 5+ shows are almost certainly generic
  for (const result of results) {
    if (result.candidates.length < GENERIC_THRESHOLD) continue;

    for (const candidate of result.candidates) {
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.url) continue;
        data.url = null;
        atomicWriteJSON(filePath, data);
        genericUrlsNulled++;
        log(`  Nulled URL: ${candidate.showId}/${candidate.file}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Nulled ${genericUrlsNulled} generic/homepage URLs`);

  // --- Tier 1: High-confidence date-based fixes ---
  console.log('\n=== TIER 1: HIGH-CONFIDENCE DATE FIXES ===');
  for (const result of results) {
    if (result.candidates.length >= GENERIC_THRESHOLD) continue; // already handled
    if (result.confidence !== 'high' || !result.suggestedWinner) continue;

    for (const candidate of result.candidates) {
      if (candidate.showId === result.suggestedWinner) continue;

      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.wrongShow || data.wrongProduction) continue;

        data.wrongShow = true;
        data.wrongShowReason = `Cross-show URL collision: review belongs to ${result.suggestedWinner} (${result.reason})`;
        atomicWriteJSON(filePath, data);
        highConfFlagged++;
        log(`  Flagged: ${candidate.showId}/${candidate.file} → belongs to ${result.suggestedWinner}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Flagged ${highConfFlagged} files as wrongShow (high-confidence)`);

  // --- Tier 2: Revival collisions where exactly 1 candidate has a score ---
  console.log('\n=== TIER 2: REVIVAL SCORE-BASED FIXES ===');
  for (const result of results) {
    if (result.candidates.length >= GENERIC_THRESHOLD) continue; // already handled
    if (result.confidence === 'high') continue; // already handled
    if (result.candidates.length !== 2) continue; // only handle 2-way collisions

    // Check if these are revival pairs (same base show name, different years)
    const shows = result.candidates.map(c => c.showId);
    const bases = shows.map(s => s.replace(/-\d{4}$/, ''));
    if (bases[0] !== bases[1]) continue; // not a revival pair

    const withScore = result.candidates.filter(c => c.hasScore);
    if (withScore.length !== 1) continue; // need exactly 1 with score

    const winner = withScore[0];
    const loser = result.candidates.find(c => c.showId !== winner.showId);

    const filePath = path.join(REVIEW_TEXTS_DIR, loser.showId, loser.file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.wrongShow || data.wrongProduction) continue;

      data.wrongShow = true;
      data.wrongShowReason = `Cross-show URL collision (revival): review likely belongs to ${winner.showId} (has score, this file does not)`;
      atomicWriteJSON(filePath, data);
      revivalScoreFlagged++;
      log(`  Flagged: ${loser.showId}/${loser.file} → likely belongs to ${winner.showId}`);
    } catch (e) {
      console.error(`  Error: ${filePath}: ${e.message}`);
    }
  }
  console.log(`Flagged ${revivalScoreFlagged} files as wrongShow (revival score-based)`);

  console.log(`\n=== APPLY SUMMARY ===`);
  console.log(`Generic URLs nulled:          ${genericUrlsNulled}`);
  console.log(`High-confidence wrongShow:    ${highConfFlagged}`);
  console.log(`Revival score-based wrongShow: ${revivalScoreFlagged}`);
  console.log(`Total files modified:         ${genericUrlsNulled + highConfFlagged + revivalScoreFlagged}`);
} else {
  console.log(`\nRun with --apply to auto-fix collisions.`);
}
