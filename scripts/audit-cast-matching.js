#!/usr/bin/env node
/**
 * Audit Script: Re-evaluate all existing cast files against the NEW matching rules.
 *
 * Outputs three buckets:
 *   KEPT      — title match score >= 5 (good matches)
 *   REJECTED  — would be rejected by new stricter rules
 *   SKIPPED   — off-broadway/west-end (IBDB is Broadway-only)
 *
 * Usage: node scripts/audit-cast-matching.js
 */

const fs = require('fs');
const path = require('path');

// Import the matching functions from ibdb-dates.js (canonical source)
const { normalizeForTitleMatch, titleMatchScore, extractTitleFromIBDBUrl } = require('./lib/ibdb-dates');
const { isLondonMarket } = require('./lib/venue-classification');

// Load data
const shows = JSON.parse(fs.readFileSync('data/shows.json', 'utf8')).shows;
const showMap = new Map(shows.map(s => [s.id, s]));

const castDir = 'data/cast';
const files = fs.readdirSync(castDir).filter(f => f.endsWith('.json'));

const kept = [];
const rejected = [];
const skipped = [];
const empty = [];

for (const f of files) {
  const cast = JSON.parse(fs.readFileSync(path.join(castDir, f), 'utf8'));
  const show = showMap.get(cast.showId);
  if (!show) continue;

  // Empty cast files — not a matching issue
  if (!cast.ibdbUrl || cast.openingNightCast.length === 0) {
    empty.push({ showId: cast.showId, title: show.title });
    continue;
  }

  const category = show.category || 'broadway';

  // Rule 4: Skip OB/WE entirely
  if (category === 'off-broadway' || isLondonMarket(category)) {
    skipped.push({
      showId: cast.showId,
      title: show.title,
      category,
      ibdbUrl: cast.ibdbUrl,
      castCount: cast.openingNightCast.length
    });
    continue;
  }

  // Rules 1-2: Stricter title score + year gate
  const tScore = titleMatchScore(show.title, cast.ibdbUrl, '');
  const openingYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) : null;

  // Extract year from IBDB URL (rough heuristic — last number in URL)
  const urlYearMatch = cast.ibdbUrl.match(/-(\d{4,})\/?$/);
  // IBDB URLs end in production IDs, not years. Try to get year from URL slug context.
  // We don't have the IBDB result year stored, so we can't do year gate here.
  // But we CAN flag the title score.

  let verdict = 'kept';
  let reason = '';

  if (tScore < 5) {
    verdict = 'rejected';
    reason = `titleScore=${tScore} (below threshold 5)`;
  }

  const entry = {
    showId: cast.showId,
    title: show.title,
    ibdbSlug: cast.ibdbUrl.match(/broadway-production\/(.+?)$/)?.[1] || cast.ibdbUrl,
    titleScore: tScore,
    castCount: cast.openingNightCast.length,
    reason
  };

  if (verdict === 'kept') {
    kept.push(entry);
  } else {
    rejected.push(entry);
  }
}

// Output results
console.log('='.repeat(70));
console.log('CAST FILE MATCHING AUDIT — NEW RULES');
console.log('='.repeat(70));
console.log(`\nTotal cast files: ${files.length}`);
console.log(`Empty (no cast/no URL): ${empty.length}`);
console.log(`Kept (good match): ${kept.length}`);
console.log(`Rejected (bad match): ${rejected.length}`);
console.log(`Skipped (OB/WE): ${skipped.length}`);

console.log('\n' + '='.repeat(70));
console.log('REJECTED — Would be blocked by new rules:');
console.log('='.repeat(70));
rejected.sort((a, b) => a.titleScore - b.titleScore);
rejected.forEach(r => {
  console.log(`  ${r.showId}`);
  console.log(`    Title: "${r.title}" → IBDB: "${r.ibdbSlug}"`);
  console.log(`    Score: ${r.titleScore} | Cast: ${r.castCount} | ${r.reason}`);
});

console.log('\n' + '='.repeat(70));
console.log('SKIPPED — OB/WE shows (IBDB is Broadway-only):');
console.log('='.repeat(70));
skipped.forEach(s => {
  console.log(`  ${s.showId} (${s.category}) — ${s.castCount} cast from: ${s.ibdbUrl}`);
});

console.log('\n' + '='.repeat(70));
console.log('BORDERLINE — Kept but with titleScore 5-7 (spot-check these):');
console.log('='.repeat(70));
const borderline = kept.filter(k => k.titleScore >= 5 && k.titleScore < 8);
borderline.forEach(b => {
  console.log(`  ${b.showId} — score=${b.titleScore} — "${b.title}" → "${b.ibdbSlug}"`);
});

console.log('\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`Good (score >= 8):      ${kept.filter(k => k.titleScore >= 8).length}`);
console.log(`Borderline (score 5-7): ${borderline.length}`);
console.log(`Rejected (score < 5):   ${rejected.length}`);
console.log(`Skipped (OB/WE):        ${skipped.length}`);
console.log(`Empty files:            ${empty.length}`);
