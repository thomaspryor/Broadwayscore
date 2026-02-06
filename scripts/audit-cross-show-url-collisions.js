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

  // --- Tier 3: Revival pairs where exactly 1 candidate has fullText ---
  console.log('\n=== TIER 3: REVIVAL FULLTEXT-BASED FIXES ===');
  let revivalFullTextFlagged = 0;
  for (const result of results) {
    if (result.candidates.length >= GENERIC_THRESHOLD) continue;
    if (result.confidence === 'high') continue;
    if (result.candidates.length < 2) continue;

    const shows = result.candidates.map(c => c.showId);
    const bases = shows.map(s => s.replace(/-\d{4}$/, ''));
    // Check all candidates share the same base (revival group)
    if (!bases.every(b => b === bases[0])) continue;

    const withText = result.candidates.filter(c => c.hasFullText);
    if (withText.length !== 1) continue; // need exactly 1 with fullText
    // Skip if already handled by Tier 2 (score-based)
    const withScore = result.candidates.filter(c => c.hasScore);
    if (withScore.length === 1) continue;

    const winner = withText[0];
    for (const candidate of result.candidates) {
      if (candidate.showId === winner.showId) continue;
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.wrongShow || data.wrongProduction) continue;
        data.wrongShow = true;
        data.wrongShowReason = `Cross-show URL collision (revival): review has fullText in ${winner.showId}, not here`;
        atomicWriteJSON(filePath, data);
        revivalFullTextFlagged++;
        log(`  Flagged: ${candidate.showId}/${candidate.file} → fullText in ${winner.showId}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Flagged ${revivalFullTextFlagged} files (revival fullText-based)`);

  // --- Tier 4: Revival pairs, no signal at all → flag older production ---
  console.log('\n=== TIER 4: REVIVAL NO-SIGNAL (FLAG OLDER) ===');
  let revivalNoSignalFlagged = 0;
  for (const result of results) {
    if (result.candidates.length >= GENERIC_THRESHOLD) continue;
    if (result.confidence === 'high') continue;

    const shows = result.candidates.map(c => c.showId);
    const bases = shows.map(s => s.replace(/-\d{4}$/, ''));
    if (!bases.every(b => b === bases[0])) continue;

    // All candidates must lack both score and fullText
    if (result.candidates.some(c => c.hasScore || c.hasFullText)) continue;

    // Sort by opening date descending (most recent first = winner)
    const sorted = [...result.candidates]
      .filter(c => c.openingDate)
      .sort((a, b) => new Date(b.openingDate) - new Date(a.openingDate));
    if (sorted.length < 2) continue;

    const winner = sorted[0]; // most recent production
    for (const candidate of result.candidates) {
      if (candidate.showId === winner.showId) continue;
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.wrongShow || data.wrongProduction) continue;
        data.wrongShow = true;
        data.wrongShowReason = `Cross-show URL collision (revival, no signal): defaulting to most recent production ${winner.showId}`;
        atomicWriteJSON(filePath, data);
        revivalNoSignalFlagged++;
        log(`  Flagged: ${candidate.showId}/${candidate.file} → defaulting to ${winner.showId}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Flagged ${revivalNoSignalFlagged} files (revival no-signal, older prod)`);

  // --- Tier 5: Non-revival 3+ candidate collisions → null URLs (generic pages) ---
  console.log('\n=== TIER 5: NON-REVIVAL 3+ CANDIDATES (NULL URLs) ===');
  let multiCandidateNulled = 0;
  for (const result of results) {
    if (result.candidates.length < 3) continue;
    if (result.candidates.length >= GENERIC_THRESHOLD) continue; // already handled by Tier 0

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (bases.every(b => b === bases[0])) continue; // revival, handled above

    // 3+ different shows sharing a URL = generic page
    for (const candidate of result.candidates) {
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.url) continue;
        data.url = null;
        atomicWriteJSON(filePath, data);
        multiCandidateNulled++;
        log(`  Nulled URL: ${candidate.showId}/${candidate.file}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Nulled ${multiCandidateNulled} URLs (non-revival 3+ candidates)`);

  // --- Tier 6: Near-revival pairs (base name substring match) ---
  console.log('\n=== TIER 6: NEAR-REVIVAL MISATTRIBUTIONS ===');
  let nearRevivalFlagged = 0;
  // Known near-revival mappings where one is clearly wrong
  const NEAR_REVIVAL_WINNERS = {
    'a-bronx-tale-the-musical-2016': 'a-bronx-tale-2007',    // musical reviews misattributed to the play
    'summer-1976-2023': 'summer-2018',                         // Summer 1976 reviews misattributed to Donna Summer musical
    'jajas-african-hair-braiding-2023': 'hair-2011',           // Jaja's reviews misattributed to Hair
  };
  for (const result of results) {
    if (result.candidates.length !== 2) continue;
    const shows = result.candidates.map(c => c.showId);
    const bases = shows.map(s => s.replace(/-\d{4}$/, ''));
    if (bases[0] === bases[1]) continue; // exact revival, handled above

    // Check known near-revival mappings
    let loserShowId = null;
    for (const [winner, loser] of Object.entries(NEAR_REVIVAL_WINNERS)) {
      if (shows.includes(winner) && shows.includes(loser)) {
        loserShowId = loser;
        break;
      }
    }
    if (!loserShowId) continue;

    const loser = result.candidates.find(c => c.showId === loserShowId);
    const filePath = path.join(REVIEW_TEXTS_DIR, loser.showId, loser.file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.wrongShow || data.wrongProduction) continue;
      data.wrongShow = true;
      data.wrongShowReason = `Cross-show URL collision (near-revival): URL belongs to different production`;
      atomicWriteJSON(filePath, data);
      nearRevivalFlagged++;
      log(`  Flagged: ${loser.showId}/${loser.file}`);
    } catch (e) {
      console.error(`  Error: ${filePath}: ${e.message}`);
    }
  }
  console.log(`Flagged ${nearRevivalFlagged} files (near-revival misattributions)`);

  // --- Tier 7: 3+ candidate revival groups, flag zero-signal productions ---
  console.log('\n=== TIER 7: MULTI-REVIVAL ZERO-SIGNAL PRODUCTIONS ===');
  let multiRevivalFlagged = 0;
  for (const result of results) {
    if (result.candidates.length < 3) continue;
    if (result.candidates.length >= GENERIC_THRESHOLD) continue;

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (!bases.every(b => b === bases[0])) continue; // not all same base

    // Group candidates by whether they have any signal
    const withSignal = result.candidates.filter(c => c.hasScore || c.hasFullText);
    if (withSignal.length === 0) {
      // All dead — flag all except most recent
      const sorted = [...result.candidates]
        .filter(c => c.openingDate)
        .sort((a, b) => new Date(b.openingDate) - new Date(a.openingDate));
      if (sorted.length < 2) continue;
      const winner = sorted[0];
      for (const candidate of result.candidates) {
        if (candidate.showId === winner.showId) continue;
        const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (data.wrongShow || data.wrongProduction) continue;
          data.wrongShow = true;
          data.wrongShowReason = `Cross-show URL collision (multi-revival, no signal): defaulting to ${winner.showId}`;
          atomicWriteJSON(filePath, data);
          multiRevivalFlagged++;
        } catch (e) {}
      }
    } else if (withSignal.length === 1) {
      // One has signal — flag the rest
      const winner = withSignal[0];
      for (const candidate of result.candidates) {
        if (candidate.showId === winner.showId) continue;
        const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (data.wrongShow || data.wrongProduction) continue;
          data.wrongShow = true;
          data.wrongShowReason = `Cross-show URL collision (multi-revival): signal only in ${winner.showId}`;
          atomicWriteJSON(filePath, data);
          multiRevivalFlagged++;
        } catch (e) {}
      }
    }
    // If multiple have signal, skip (too ambiguous) — handled by Tier 14
  }
  console.log(`Flagged ${multiRevivalFlagged} files (multi-revival zero-signal)`);

  // Helper: detect same-opening-date double-bill pairs (Richard III/Twelfth Night, etc.)
  function isSameDateDoubleBill(result) {
    if (result.candidates.length !== 2) return false;
    const dates = result.candidates.map(c => c.openingDate).filter(Boolean);
    if (dates.length !== 2) return false;
    const d1 = new Date(dates[0]), d2 = new Date(dates[1]);
    const daysDiff = Math.abs((d1 - d2) / (1000 * 60 * 60 * 24));
    if (daysDiff > 14) return false;
    // Must be non-revival (different base names) to be a double-bill
    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    return bases[0] !== bases[1];
  }

  // --- Tier 8: Both-scored revival pairs → flag older production ---
  console.log('\n=== TIER 8: BOTH-SCORED REVIVAL (FLAG OLDER) ===');
  let bothScoredRevivalFlagged = 0;
  for (const result of results) {
    if (result.candidates.length < 2) continue;
    if (result.candidates.length >= GENERIC_THRESHOLD) continue;
    if (result.confidence === 'high') continue;

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (!bases.every(b => b === bases[0])) continue; // revival only

    const scored = result.candidates.filter(c => c.hasScore);
    if (scored.length < 2) continue; // need 2+ scored (both-scored)

    // Sort by opening date descending, keep most recent as winner
    const sorted = [...result.candidates]
      .filter(c => c.openingDate)
      .sort((a, b) => new Date(b.openingDate) - new Date(a.openingDate));
    if (sorted.length < 2) continue;
    const winner = sorted[0];

    for (const candidate of result.candidates) {
      if (candidate.showId === winner.showId && candidate.file === winner.file) continue;
      // Don't flag if candidate is ALSO the most recent production (multiple files for same show)
      if (candidate.showId === winner.showId) continue;
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.wrongShow || data.wrongProduction) continue;
        data.wrongShow = true;
        data.wrongShowReason = `Cross-show URL collision (revival, both scored): review likely belongs to ${winner.showId} (most recent production)`;
        atomicWriteJSON(filePath, data);
        bothScoredRevivalFlagged++;
        log(`  Flagged: ${candidate.showId}/${candidate.file} → belongs to ${winner.showId}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Flagged ${bothScoredRevivalFlagged} files (both-scored revival, older prod)`);

  // --- Tier 9: Non-revival one-scored pairs → flag no-score candidate ---
  console.log('\n=== TIER 9: NON-REVIVAL ONE-SCORED (FLAG NO-SCORE) ===');
  let nonRevivalOneScoredFlagged = 0;
  for (const result of results) {
    if (result.candidates.length !== 2) continue;
    if (isSameDateDoubleBill(result)) continue;

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (bases[0] === bases[1]) continue; // skip revivals

    const scored = result.candidates.filter(c => c.hasScore || c.hasFullText);
    if (scored.length !== 1) continue;

    const loser = result.candidates.find(c => !c.hasScore && !c.hasFullText);
    if (!loser) continue;
    const winner = scored[0];

    const filePath = path.join(REVIEW_TEXTS_DIR, loser.showId, loser.file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.wrongShow || data.wrongProduction) continue;
      data.wrongShow = true;
      data.wrongShowReason = `Cross-show URL collision: review has score/text in ${winner.showId}, not here`;
      atomicWriteJSON(filePath, data);
      nonRevivalOneScoredFlagged++;
      log(`  Flagged: ${loser.showId}/${loser.file} → signal in ${winner.showId}`);
    } catch (e) {
      console.error(`  Error: ${filePath}: ${e.message}`);
    }
  }
  console.log(`Flagged ${nonRevivalOneScoredFlagged} files (non-revival one-scored)`);

  // --- Tier 10: Non-revival both-scored pairs → flag older ---
  console.log('\n=== TIER 10: NON-REVIVAL BOTH-SCORED (FLAG OLDER) ===');
  let nonRevivalBothScoredFlagged = 0;
  for (const result of results) {
    if (result.candidates.length !== 2) continue;
    if (isSameDateDoubleBill(result)) continue;

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (bases[0] === bases[1]) continue; // skip revivals

    const scored = result.candidates.filter(c => c.hasScore);
    if (scored.length < 2) continue; // need both scored

    const sorted = [...result.candidates]
      .filter(c => c.openingDate)
      .sort((a, b) => new Date(b.openingDate) - new Date(a.openingDate));
    if (sorted.length < 2) continue;
    const winner = sorted[0];
    const loser = sorted[1];

    const filePath = path.join(REVIEW_TEXTS_DIR, loser.showId, loser.file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.wrongShow || data.wrongProduction) continue;
      data.wrongShow = true;
      data.wrongShowReason = `Cross-show URL collision (both scored): review likely belongs to ${winner.showId} (more recent opening)`;
      atomicWriteJSON(filePath, data);
      nonRevivalBothScoredFlagged++;
      log(`  Flagged: ${loser.showId}/${loser.file} → belongs to ${winner.showId}`);
    } catch (e) {
      console.error(`  Error: ${filePath}: ${e.message}`);
    }
  }
  console.log(`Flagged ${nonRevivalBothScoredFlagged} files (non-revival both-scored, older)`);

  // --- Tier 11: No-signal non-revival pairs → null URLs ---
  console.log('\n=== TIER 11: NO-SIGNAL NON-REVIVAL (NULL URLs) ===');
  let noSignalNonRevivalNulled = 0;
  for (const result of results) {
    if (result.candidates.length !== 2) continue;
    if (isSameDateDoubleBill(result)) continue;

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (bases[0] === bases[1]) continue; // skip revivals

    if (result.candidates.some(c => c.hasScore || c.hasFullText)) continue; // need no signal

    for (const candidate of result.candidates) {
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.url) continue;
        data.url = null;
        atomicWriteJSON(filePath, data);
        noSignalNonRevivalNulled++;
        log(`  Nulled URL: ${candidate.showId}/${candidate.file}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Nulled ${noSignalNonRevivalNulled} URLs (no-signal non-revival)`);

  // --- Tier 12: No-signal revival with null dates → null URLs ---
  console.log('\n=== TIER 12: NO-SIGNAL REVIVAL NULL-DATE (NULL URLs) ===');
  let noSignalRevivalNulled = 0;
  for (const result of results) {
    if (result.candidates.length < 2) continue;
    if (result.candidates.length >= GENERIC_THRESHOLD) continue;

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (!bases.every(b => b === bases[0])) continue; // revival only
    if (result.candidates.some(c => c.hasScore || c.hasFullText)) continue;

    // This catches cases Tier 4 missed (null opening dates)
    const withDates = result.candidates.filter(c => c.openingDate);
    if (withDates.length >= 2) continue; // Tier 4 should handle, but just in case

    for (const candidate of result.candidates) {
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.url) continue;
        data.url = null;
        atomicWriteJSON(filePath, data);
        noSignalRevivalNulled++;
        log(`  Nulled URL: ${candidate.showId}/${candidate.file}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Nulled ${noSignalRevivalNulled} URLs (no-signal revival, null dates)`);

  // --- Tier 13: 3+ revival with multi-signal → flag no-signal candidates ---
  console.log('\n=== TIER 13: MULTI-REVIVAL FLAG NO-SIGNAL CANDIDATES ===');
  let multiRevivalNoSignalFlagged = 0;
  for (const result of results) {
    if (result.candidates.length < 3) continue;
    if (result.candidates.length >= GENERIC_THRESHOLD) continue;

    const bases = result.candidates.map(c => c.showId.replace(/-\d{4}$/, ''));
    if (!bases.every(b => b === bases[0])) continue;

    const withSignal = result.candidates.filter(c => c.hasScore || c.hasFullText);
    const withoutSignal = result.candidates.filter(c => !c.hasScore && !c.hasFullText);
    if (withSignal.length < 2 || withoutSignal.length === 0) continue;

    for (const candidate of withoutSignal) {
      const filePath = path.join(REVIEW_TEXTS_DIR, candidate.showId, candidate.file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.wrongShow || data.wrongProduction) continue;
        data.wrongShow = true;
        data.wrongShowReason = `Cross-show URL collision (multi-revival): no score/text here, signal in other productions`;
        atomicWriteJSON(filePath, data);
        multiRevivalNoSignalFlagged++;
        log(`  Flagged: ${candidate.showId}/${candidate.file}`);
      } catch (e) {
        console.error(`  Error: ${filePath}: ${e.message}`);
      }
    }
  }
  console.log(`Flagged ${multiRevivalNoSignalFlagged} files (multi-revival, no-signal candidates)`);

  const totalFixed = genericUrlsNulled + highConfFlagged + revivalScoreFlagged +
    revivalFullTextFlagged + revivalNoSignalFlagged + multiCandidateNulled +
    nearRevivalFlagged + multiRevivalFlagged +
    bothScoredRevivalFlagged + nonRevivalOneScoredFlagged + nonRevivalBothScoredFlagged +
    noSignalNonRevivalNulled + noSignalRevivalNulled + multiRevivalNoSignalFlagged;

  console.log(`\n=== APPLY SUMMARY ===`);
  console.log(`Tier 0 - Generic URLs nulled:         ${genericUrlsNulled}`);
  console.log(`Tier 1 - High-confidence wrongShow:   ${highConfFlagged}`);
  console.log(`Tier 2 - Revival score-based:         ${revivalScoreFlagged}`);
  console.log(`Tier 3 - Revival fullText-based:      ${revivalFullTextFlagged}`);
  console.log(`Tier 4 - Revival no-signal (older):   ${revivalNoSignalFlagged}`);
  console.log(`Tier 5 - Non-revival 3+ (null URLs):  ${multiCandidateNulled}`);
  console.log(`Tier 6 - Near-revival misattrib:      ${nearRevivalFlagged}`);
  console.log(`Tier 7 - Multi-revival zero-signal:   ${multiRevivalFlagged}`);
  console.log(`Tier 8 - Both-scored revival (older):  ${bothScoredRevivalFlagged}`);
  console.log(`Tier 9 - Non-revival one-scored:       ${nonRevivalOneScoredFlagged}`);
  console.log(`Tier 10 - Non-revival both-scored:     ${nonRevivalBothScoredFlagged}`);
  console.log(`Tier 11 - No-signal non-revival null:  ${noSignalNonRevivalNulled}`);
  console.log(`Tier 12 - No-signal revival null-date: ${noSignalRevivalNulled}`);
  console.log(`Tier 13 - Multi-revival no-signal:     ${multiRevivalNoSignalFlagged}`);
  console.log(`Total files modified:                  ${totalFixed}`);
} else {
  console.log(`\nRun with --apply to auto-fix collisions.`);
}
