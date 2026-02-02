#!/usr/bin/env node

/**
 * Comprehensive Explicit Score Audit
 *
 * Validates ALL reviews with explicit critic scores to ensure calibration data is trustworthy.
 *
 * Improvements over basic audit (based on agent critique):
 * 1. Cross-aggregator validation - checks if DTLI/BWW/ShowScore excerpts mention different scores
 * 2. Statistical thresholds - uses 2σ instead of arbitrary cutoffs
 * 3. Confidence tiers - prioritizes what actually needs manual review
 * 4. Outlet stratification - identifies systematic issues by outlet
 * 5. Duplicate detection - finds same review with conflicting scores
 * 6. Score context extraction - shows the actual sentence containing the score
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = 'data/review-texts';
const OUTPUT_FILE = 'data/audit/comprehensive-score-audit.json';
const SUMMARY_FILE = 'data/audit/comprehensive-score-audit-summary.md';

// Note: Aggregators (BWW, DTLI, ShowScore) only provide thumbs (Up/Down/Meh),
// NOT star ratings or letter grades. Any score in their excerpts is from
// the review text itself, not the aggregator's score assignment.
// We only look for star ratings in excerpts since letter grades cause
// false positives (e.g., "Jonathan A. Abrams" matching "A" as a grade).

// Normalization table - document explicitly for verification
const NORMALIZATION_TABLE = {
  // Star ratings (out of 5)
  '5/5': 100, '4.5/5': 90, '4/5': 80, '3.5/5': 70, '3/5': 60,
  '2.5/5': 50, '2/5': 40, '1.5/5': 30, '1/5': 20, '0.5/5': 10, '0/5': 0,
  // Star ratings (out of 4)
  '4/4': 100, '3.5/4': 88, '3/4': 75, '2.5/4': 63, '2/4': 50,
  '1.5/4': 38, '1/4': 25, '0.5/4': 13, '0/4': 0,
  // Letter grades
  'A+': 98, 'A': 95, 'A-': 92,
  'B+': 88, 'B': 85, 'B-': 82,
  'C+': 78, 'C': 75, 'C-': 72,
  'D+': 68, 'D': 65, 'D-': 62,
  'F': 50,
};

function loadAllReviews() {
  const reviews = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        reviews.push({
          ...data,
          _filename: file,
          _filepath: path.join(showDir, file),
          _showId: showId
        });
      } catch (e) {
        console.error(`Error reading ${file}:`, e.message);
      }
    }
  }

  return reviews;
}

function extractScoreFromText(text, options = {}) {
  if (!text) return null;

  // Look for star patterns - most reliable
  const starMatch = text.match(/(\d(?:\.\d)?)\s*(?:out of\s*)?(?:\/\s*)?([45])\s*stars?/i);
  if (starMatch) {
    return { raw: `${starMatch[1]}/${starMatch[2]}`, type: 'stars' };
  }

  // Look for unicode stars - reliable
  const unicodeMatch = text.match(/(★+)(☆*)/);
  if (unicodeMatch) {
    const filled = unicodeMatch[1].length;
    const total = filled + (unicodeMatch[2] ? unicodeMatch[2].length : 0);
    if (total >= 4 && total <= 5) {
      return { raw: `${filled}/${total}`, type: 'unicode-stars' };
    }
  }

  // Skip letter grades if requested (e.g., for aggregator excerpts which never
  // have letter grades - only thumbs up/down. Any "grade" found would be a
  // false positive like "Jonathan A. Abrams")
  if (options.skipLetterGrades) {
    return null;
  }

  // Letter grades - VERY STRICT to avoid false positives
  // Only match: "Grade: A", "Rating: B+", etc.
  // "grade" requires colon — "Grade B" is an idiom meaning "mediocre"
  // Removed "gives a X" / "rates a X" / "X grade" / "score X" — all capture article "a" as grade "A"
  const strictGradePatterns = [
    /\b(?:grade:\s*|rating[:\s]+)([A-D][+-]?|F)(?!\w)/i,  // "Grade: B", "Rating: A-"
    /[.!?]\s+([A-D][+-]?|F)\s*$/,              // Ends with letter grade after punctuation
    /\breview:\s*([A-D][+-]?|F)(?!\w)/i,       // "Review: B"
  ];

  for (const pattern of strictGradePatterns) {
    const gradeMatch = text.match(pattern);
    if (gradeMatch && gradeMatch[1]) {
      const grade = gradeMatch[1].toUpperCase();
      if (['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'].includes(grade)) {
        return { raw: grade, type: 'letter-grade' };
      }
    }
  }

  return null;
}

function normalizeScore(rawScore) {
  if (!rawScore) return null;

  const raw = rawScore.toLowerCase().trim();

  // 1. Parse star ratings with denominator FIRST (most specific)
  // e.g., "3/4", "4 out of 5", "4.5/5"
  const starMatch = raw.match(/(\d(?:\.\d)?)\s*(?:\/|out of)\s*(\d)/);
  if (starMatch) {
    const score = parseFloat(starMatch[1]);
    const max = parseFloat(starMatch[2]);
    return Math.round((score / max) * 100);
  }

  // 2. Parse star ratings without denominator (e.g., "2 stars", "3.5 stars")
  // MUST check before letter grades to avoid "2 stars" matching 'a' in 'stars'
  const starsOnlyMatch = raw.match(/^(\d(?:\.\d)?)\s*stars?$/);
  if (starsOnlyMatch) {
    const score = parseFloat(starsOnlyMatch[1]);
    // Determine max: if score is 5, assume out of 5. If has .5, assume out of 5.
    // Otherwise (1-4 whole numbers), assume out of 4.
    const max = (score === 5 || score % 1 !== 0) ? 5 : 4;
    return Math.round((score / max) * 100);
  }

  // 3. Direct lookup for EXACT star rating matches in our table (e.g., "4/5", "3.5/4")
  // Only check keys that look like ratings, not single letters
  for (const [key, value] of Object.entries(NORMALIZATION_TABLE)) {
    const keyLower = key.toLowerCase();
    // Only match if key is a star rating (contains /) not a single letter
    if (keyLower.includes('/') && raw.includes(keyLower)) {
      return value;
    }
  }

  // 4. Parse letter grades - STRICT: must be standalone grade
  // e.g., "B+", "Grade: A-" but NOT "stars" (which has 'a' in it)
  const gradeMatch = raw.match(/^([a-f][+-]?)$|grade[:\s]+([a-f][+-]?)/i);
  if (gradeMatch) {
    const grade = (gradeMatch[1] || gradeMatch[2]).toUpperCase();
    return NORMALIZATION_TABLE[grade] || null;
  }

  return null;
}

function findDuplicates(reviews) {
  const groups = {};

  for (const review of reviews) {
    const key = `${review.outletId}--${review.criticName}--${review._showId}`.toLowerCase();
    if (!groups[key]) groups[key] = [];
    groups[key].push(review);
  }

  const duplicates = [];
  for (const [key, group] of Object.entries(groups)) {
    if (group.length > 1) {
      duplicates.push({
        key,
        count: group.length,
        files: group.map(r => r._filename),
        scores: group.map(r => r.originalScore).filter(Boolean),
        hasConflict: new Set(group.map(r => r.assignedScore)).size > 1
      });
    }
  }

  return duplicates;
}

function checkAggregatorConflict(review) {
  const conflicts = [];
  const storedScore = review.originalScore;
  const storedNormalized = review.assignedScore;

  const excerpts = [
    { source: 'dtli', text: review.dtliExcerpt },
    { source: 'bww', text: review.bwwExcerpt },
    { source: 'showScore', text: review.showScoreExcerpt },
  ];

  for (const { source, text } of excerpts) {
    if (!text) continue;

    // IMPORTANT: Skip letter grade detection for aggregator excerpts!
    // BWW, DTLI, and ShowScore only provide thumbs (Up/Down/Meh), NOT letter grades.
    // Any "letter grade" found would be a false positive from names like
    // "Jonathan A. Abrams" where the middle initial matches the grade pattern.
    // We only look for star ratings which ARE sometimes included in excerpts.
    const found = extractScoreFromText(text, { skipLetterGrades: true });
    if (found) {
      const normalized = normalizeScore(found.raw);
      if (normalized !== null && Math.abs(normalized - storedNormalized) > 10) {
        conflicts.push({
          source,
          foundRaw: found.raw,
          foundNormalized: normalized,
          storedRaw: storedScore,
          storedNormalized,
          diff: normalized - storedNormalized
        });
      }
    }
  }

  return conflicts;
}

function getScoreContext(review) {
  // Try to find the sentence or context containing the score
  const text = review.fullText || review.dtliExcerpt || review.bwwExcerpt || '';
  const score = review.originalScore;

  if (!score || !text) return null;

  // Ensure score is a string
  const scoreStr = String(score);

  // Look for the score in the text
  const scorePatterns = [
    new RegExp(`.{0,50}${scoreStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.{0,50}`, 'i'),
    /★+☆*.{0,50}/,  // Unicode stars with context
  ];

  for (const pattern of scorePatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }

  return null;
}

function getCriticExplicitScore(review) {
  // Get the critic's explicit score, normalized to 0-100
  // ALWAYS re-normalize from originalScore to catch stale originalScoreNormalized values
  // Priority: normalize(originalScore) > originalScore if numeric > originalScoreNormalized (fallback)
  if (review.originalScore !== null && review.originalScore !== undefined) {
    // Try to normalize it fresh
    const normalized = normalizeScore(String(review.originalScore));
    if (normalized !== null) return normalized;
    // If originalScore is already a number, use it directly
    if (typeof review.originalScore === 'number') return review.originalScore;
  }
  // Fallback to stored value only if originalScore couldn't be normalized
  if (typeof review.originalScoreNormalized === 'number') {
    return review.originalScoreNormalized;
  }
  return null;
}

function calculateStatistics(reviews) {
  const withScores = reviews.filter(r => {
    const criticScore = getCriticExplicitScore(r);
    const hasLlm = r.llmScore && typeof r.llmScore.score === 'number';
    return criticScore !== null && hasLlm;
  });

  console.log(`  Stats: ${withScores.length} reviews have both critic explicit score and LLM score`);

  if (withScores.length === 0) return { mean: 0, stdDev: 0, count: 0 };

  const diffs = withScores.map(r => {
    const criticScore = getCriticExplicitScore(r);
    return r.llmScore.score - criticScore;
  });

  // Debug: sample a few diffs
  console.log(`  Sample diffs (first 5): ${diffs.slice(0, 5).map(d => d.toFixed(1)).join(', ')}`);
  console.log(`  Sample diffs range: min=${Math.min(...diffs).toFixed(1)}, max=${Math.max(...diffs).toFixed(1)}`);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / diffs.length;
  const stdDev = Math.sqrt(variance);

  return { mean, stdDev, count: withScores.length };
}

function runAudit() {
  console.log('Loading all reviews...');
  const allReviews = loadAllReviews();
  console.log(`Loaded ${allReviews.length} total reviews`);

  // Filter to reviews with explicit scores
  const withExplicit = allReviews.filter(r => r.originalScore);
  console.log(`Found ${withExplicit.length} reviews with explicit scores`);

  // Calculate statistics for LLM disagreement
  const stats = calculateStatistics(withExplicit);
  console.log(`LLM disagreement stats: mean=${stats.mean.toFixed(1)}, stdDev=${stats.stdDev.toFixed(1)}`);

  const twoSigma = Math.abs(stats.mean) + (2 * stats.stdDev);
  console.log(`2σ threshold: ${twoSigma.toFixed(1)} points`);

  // Find duplicates
  const duplicates = findDuplicates(allReviews);
  console.log(`Found ${duplicates.length} duplicate review groups`);

  // Analyze each review
  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      totalReviews: allReviews.length,
      withExplicitScore: withExplicit.length,
      llmStats: stats,
      twoSigmaThreshold: twoSigma
    },
    normalizationTable: NORMALIZATION_TABLE,
    duplicates: duplicates.filter(d => d.hasConflict),
    byOutlet: {},
    bySourceType: {},
    flagged: {
      aggregatorConflict: [],
      highLlmDisagreement: [],
      conversionEdgeCases: [],
      problematicSource: [],
      ambiguousScore: [],
      missingContext: []
    },
    tiers: {
      A: [], // Skip manual review
      B: [], // Spot-check sample
      C: []  // Full manual review required
    }
  };

  for (const review of withExplicit) {
    const reviewId = `${review._showId}/${review._filename}`;
    const criticScore = getCriticExplicitScore(review);
    const llmScore = review.llmScore?.score;
    const llmDiff = (llmScore && criticScore) ? (llmScore - criticScore) : null;

    const entry = {
      reviewId,
      outlet: review.outlet,
      outletId: review.outletId,
      critic: review.criticName,
      originalScore: review.originalScore,
      criticExplicitScore: criticScore,
      scoreSource: review.scoreSource || 'unknown',
      llmScore,
      llmDiff,
      url: review.url,
      scoreContext: getScoreContext(review),
      flags: []
    };

    // Track by outlet
    if (!results.byOutlet[review.outletId]) {
      results.byOutlet[review.outletId] = { count: 0, reviews: [], avgLlmDiff: 0 };
    }
    results.byOutlet[review.outletId].count++;
    results.byOutlet[review.outletId].reviews.push(reviewId);
    if (llmDiff !== null) {
      results.byOutlet[review.outletId].avgLlmDiff += llmDiff;
    }

    // Track by source type
    const sourceType = review.scoreSource || 'unknown';
    if (!results.bySourceType[sourceType]) {
      results.bySourceType[sourceType] = { count: 0, reviews: [] };
    }
    results.bySourceType[sourceType].count++;
    results.bySourceType[sourceType].reviews.push(reviewId);

    // Check 1: Aggregator conflict
    const conflicts = checkAggregatorConflict(review);
    if (conflicts.length > 0) {
      entry.aggregatorConflicts = conflicts;
      entry.flags.push('aggregator_conflict');
      results.flagged.aggregatorConflict.push(entry);
    }

    // Check 2: High LLM disagreement (>2σ from mean)
    if (llmDiff !== null && Math.abs(llmDiff - stats.mean) > twoSigma) {
      entry.flags.push('high_llm_disagreement');
      results.flagged.highLlmDisagreement.push(entry);
    }

    // Check 3: Conversion edge cases
    const edgeCases = ['B+', 'B-', 'A-', 'C+', '3.5', '2.5'];
    const originalScoreStr = String(review.originalScore || '');
    if (edgeCases.some(ec => originalScoreStr.includes(ec))) {
      entry.flags.push('conversion_edge_case');
      results.flagged.conversionEdgeCases.push(entry);
    }

    // Check 4: Problematic source
    const problematicSources = ['extracted-unicode-stars', 'text-pattern', 'unknown'];
    if (problematicSources.includes(sourceType)) {
      entry.flags.push('problematic_source');
      results.flagged.problematicSource.push(entry);
    }

    // Check 5: Ambiguous score
    const ambiguousPatterns = ['mixed', 'recommended', 'fresh', 'rotten'];
    if (ambiguousPatterns.some(p => originalScoreStr.toLowerCase().includes(p))) {
      entry.flags.push('ambiguous_score');
      results.flagged.ambiguousScore.push(entry);
    }

    // Check 6: Missing context (can't verify where score came from)
    if (!entry.scoreContext && sourceType !== 'og-description') {
      entry.flags.push('missing_context');
      results.flagged.missingContext.push(entry);
    }

    // Assign to confidence tier
    if (entry.flags.length === 0 && llmDiff !== null && Math.abs(llmDiff) < 15) {
      // Tier A: No flags, LLM agrees within 15 points
      results.tiers.A.push(entry);
    } else if (entry.flags.length <= 1 && !entry.flags.includes('aggregator_conflict') && !entry.flags.includes('high_llm_disagreement')) {
      // Tier B: Minor issues only
      results.tiers.B.push(entry);
    } else {
      // Tier C: Multiple flags or serious issues
      results.tiers.C.push(entry);
    }
  }

  // Calculate average LLM diff per outlet
  for (const outletId of Object.keys(results.byOutlet)) {
    const outlet = results.byOutlet[outletId];
    outlet.avgLlmDiff = outlet.count > 0 ? (outlet.avgLlmDiff / outlet.count).toFixed(1) : 'N/A';
  }

  return results;
}

function generateSummary(results) {
  const lines = [];

  lines.push('# Comprehensive Explicit Score Audit');
  lines.push(`\n**Generated:** ${results.meta.generatedAt}`);
  lines.push(`\n## Overview\n`);
  lines.push(`- Total reviews: ${results.meta.totalReviews}`);
  lines.push(`- With explicit score: ${results.meta.withExplicitScore}`);
  lines.push(`- LLM disagreement mean: ${results.meta.llmStats.mean.toFixed(1)} points`);
  lines.push(`- LLM disagreement std dev: ${results.meta.llmStats.stdDev.toFixed(1)} points`);
  lines.push(`- 2σ threshold: ${results.meta.twoSigmaThreshold.toFixed(1)} points`);

  lines.push(`\n## Confidence Tiers\n`);
  lines.push(`| Tier | Description | Count | Action |`);
  lines.push(`|------|-------------|-------|--------|`);
  lines.push(`| A | No flags, LLM agrees | ${results.tiers.A.length} | Skip review |`);
  lines.push(`| B | Minor issues | ${results.tiers.B.length} | Spot-check sample |`);
  lines.push(`| C | Serious flags | ${results.tiers.C.length} | **Full review required** |`);

  lines.push(`\n## Flagged Reviews by Priority\n`);

  lines.push(`### Priority 1: Aggregator Conflict (${results.flagged.aggregatorConflict.length})`);
  lines.push(`Reviews where DTLI/BWW/ShowScore excerpt contains a different score.\n`);
  for (const r of results.flagged.aggregatorConflict.slice(0, 10)) {
    lines.push(`- **${r.reviewId}**: stored ${r.originalScore} (${r.criticExplicitScore}) but aggregator shows ${r.aggregatorConflicts[0].foundRaw} (${r.aggregatorConflicts[0].foundNormalized})`);
  }
  if (results.flagged.aggregatorConflict.length > 10) {
    lines.push(`- ... and ${results.flagged.aggregatorConflict.length - 10} more`);
  }

  lines.push(`\n### Priority 2: High LLM Disagreement (${results.flagged.highLlmDisagreement.length})`);
  lines.push(`Reviews where LLM score differs by >2σ from the mean disagreement.\n`);
  for (const r of results.flagged.highLlmDisagreement.slice(0, 10)) {
    lines.push(`- **${r.reviewId}**: explicit=${r.criticExplicitScore}, LLM=${r.llmScore}, diff=${r.llmDiff > 0 ? '+' : ''}${r.llmDiff}`);
  }
  if (results.flagged.highLlmDisagreement.length > 10) {
    lines.push(`- ... and ${results.flagged.highLlmDisagreement.length - 10} more`);
  }

  lines.push(`\n### Priority 3: Problematic Source (${results.flagged.problematicSource.length})`);
  lines.push(`Scores from unreliable extraction methods.\n`);
  const bySource = {};
  for (const r of results.flagged.problematicSource) {
    if (!bySource[r.scoreSource]) bySource[r.scoreSource] = 0;
    bySource[r.scoreSource]++;
  }
  for (const [source, count] of Object.entries(bySource)) {
    lines.push(`- ${source}: ${count} reviews`);
  }

  lines.push(`\n### Priority 4: Conversion Edge Cases (${results.flagged.conversionEdgeCases.length})`);
  lines.push(`Scores at grade boundaries (B+/B-, 3.5 stars, etc.).\n`);

  lines.push(`\n### Other Flags`);
  lines.push(`- Ambiguous scores: ${results.flagged.ambiguousScore.length}`);
  lines.push(`- Missing context: ${results.flagged.missingContext.length}`);

  lines.push(`\n## By Outlet (sorted by count)\n`);
  lines.push(`| Outlet | Count | Avg LLM Diff | Notes |`);
  lines.push(`|--------|-------|--------------|-------|`);
  const sortedOutlets = Object.entries(results.byOutlet).sort((a, b) => b[1].count - a[1].count);
  for (const [outletId, data] of sortedOutlets.slice(0, 15)) {
    const notes = Math.abs(parseFloat(data.avgLlmDiff)) > 10 ? '⚠️ High bias' : '';
    lines.push(`| ${outletId} | ${data.count} | ${data.avgLlmDiff} | ${notes} |`);
  }

  lines.push(`\n## By Score Source\n`);
  lines.push(`| Source | Count | Reliability |`);
  lines.push(`|--------|-------|-------------|`);
  const sourceReliability = {
    'og-description': '✅ High',
    'live-fetch': '✅ High',
    'letter-grade': '⚠️ Medium',
    'text-pattern': '⚠️ Medium',
    'extracted-unicode-stars': '❌ Low',
    'star-icon': '⚠️ Medium',
    'unknown': '❌ Low'
  };
  for (const [source, data] of Object.entries(results.bySourceType).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${source} | ${data.count} | ${sourceReliability[source] || '❓ Unknown'} |`);
  }

  lines.push(`\n## Duplicates with Score Conflicts\n`);
  if (results.duplicates.length === 0) {
    lines.push('None found.');
  } else {
    for (const dup of results.duplicates) {
      lines.push(`- **${dup.key}**: ${dup.count} files with scores ${dup.scores.join(', ')}`);
    }
  }

  lines.push(`\n## Tier C Reviews (Require Manual Review)\n`);
  lines.push(`\n<details><summary>Click to expand ${results.tiers.C.length} reviews</summary>\n`);
  for (const r of results.tiers.C) {
    lines.push(`### ${r.reviewId}`);
    lines.push(`- **Outlet:** ${r.outlet}`);
    lines.push(`- **Critic:** ${r.critic}`);
    lines.push(`- **Original Score:** ${r.originalScore}`);
    lines.push(`- **Critic Score:** ${r.criticExplicitScore}`);
    lines.push(`- **LLM Score:** ${r.llmScore || 'N/A'} (diff: ${r.llmDiff || 'N/A'})`);
    lines.push(`- **Score Source:** ${r.scoreSource}`);
    lines.push(`- **Flags:** ${r.flags.join(', ')}`);
    lines.push(`- **URL:** ${r.url || 'N/A'}`);
    if (r.scoreContext) {
      lines.push(`- **Score Context:** "${r.scoreContext}"`);
    }
    if (r.aggregatorConflicts) {
      for (const c of r.aggregatorConflicts) {
        lines.push(`- **⚠️ ${c.source} shows:** ${c.foundRaw} (${c.foundNormalized})`);
      }
    }
    lines.push('');
  }
  lines.push(`</details>\n`);

  lines.push(`\n## Recommended Actions\n`);
  lines.push(`1. **Manually verify all ${results.tiers.C.length} Tier C reviews** - these have serious flags`);
  lines.push(`2. **Spot-check 20 random Tier B reviews** - verify the 'minor issues' are truly minor`);
  lines.push(`3. **Investigate outlets with high LLM bias** - systematic errors may indicate extraction bugs`);
  lines.push(`4. **Remove or fix reviews with aggregator conflicts** - clear evidence of wrong score`);

  return lines.join('\n');
}

// Main
console.log('Running comprehensive score audit...\n');
const results = runAudit();

// Ensure output directory exists
const outputDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write JSON results
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
console.log(`\nJSON results written to: ${OUTPUT_FILE}`);

// Write summary markdown
const summary = generateSummary(results);
fs.writeFileSync(SUMMARY_FILE, summary);
console.log(`Summary written to: ${SUMMARY_FILE}`);

// Print quick stats
console.log('\n=== QUICK SUMMARY ===');
console.log(`Total with explicit scores: ${results.meta.withExplicitScore}`);
console.log(`Tier A (skip review): ${results.tiers.A.length}`);
console.log(`Tier B (spot-check): ${results.tiers.B.length}`);
console.log(`Tier C (FULL REVIEW): ${results.tiers.C.length}`);
console.log(`\nFlagged by type:`);
console.log(`  - Aggregator conflict: ${results.flagged.aggregatorConflict.length}`);
console.log(`  - High LLM disagreement: ${results.flagged.highLlmDisagreement.length}`);
console.log(`  - Problematic source: ${results.flagged.problematicSource.length}`);
console.log(`  - Conversion edge cases: ${results.flagged.conversionEdgeCases.length}`);
