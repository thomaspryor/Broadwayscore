#!/usr/bin/env node
/**
 * Generate Scoring Audit Report (Phase 4A)
 *
 * Monthly audit script that scans all review-text files and reports:
 * - Reviews with data quality flags (showNotMentioned, misattributedFullText, duplicateTextOf)
 * - Top highest-delta reviews (LLM vs thumb, >25pt gap)
 * - Reviews scored on single excerpts with non-low confidence
 * - Reviews where mehThumbIgnored is true
 * - Month-over-month trends
 *
 * Usage:
 *   node scripts/generate-scoring-audit.js              # Generate audit report
 *   node scripts/generate-scoring-audit.js --dry-run    # Report to stdout only
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const REPORT_PATH = path.join(AUDIT_DIR, 'scoring-audit.json');
const HISTORY_PATH = path.join(AUDIT_DIR, 'scoring-audit-history.json');

// Ensure audit directory exists
if (!fs.existsSync(AUDIT_DIR)) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

// Stats
const stats = {
  totalReviews: 0,
  reviewsWithScore: 0,
  reviewsWithFullText: 0,
  reviewsWithLlmScore: 0,

  // Quality flags
  showNotMentioned: [],
  misattributed: [],
  duplicateText: [],

  // Scoring issues
  highDeltaReviews: [],   // LLM vs thumb >25pt gap
  singleExcerptNonLow: [], // Single excerpt scored with non-low confidence
  mehThumbIgnored: [],

  // Text quality distribution
  textQuality: { full: 0, partial: 0, truncated: 0, excerpt: 0, missing: 0, unknown: 0 },
};

console.log('=== SCORING AUDIT ===\n');

// Process all review-text files
const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => d.name);

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch (e) {
    continue;
  }

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      stats.totalReviews++;

      // Skip excluded reviews
      if (data.wrongProduction || data.wrongShow || data.wrongAttribution) continue;

      // Count scores
      if (data.assignedScore || (data.llmScore && data.llmScore.score)) stats.reviewsWithScore++;
      if (data.fullText && data.fullText.length > 100) stats.reviewsWithFullText++;
      if (data.llmScore && data.llmScore.score) stats.reviewsWithLlmScore++;

      // Text quality distribution
      const quality = data.textQuality || data.contentTier || 'unknown';
      if (stats.textQuality[quality] !== undefined) {
        stats.textQuality[quality]++;
      } else {
        stats.textQuality.unknown++;
      }

      // Quality flags
      if (data.showNotMentioned === true) {
        stats.showNotMentioned.push({ showId, file, reason: 'Show title not found in text' });
      }
      if (data.misattributedFullText === true) {
        stats.misattributed.push({
          showId, file,
          extractedByline: data.extractedByline,
          expectedCritic: data.expectedCritic || data.criticName
        });
      }
      if (data.duplicateTextOf) {
        stats.duplicateText.push({ showId, file, duplicateOf: data.duplicateTextOf });
      }

      // High delta reviews (LLM vs thumb >25pt)
      if (data.llmScore && data.llmScore.score) {
        const THUMB_SCORES = { 'Up': 80, 'Meh': 60, 'Flat': 60, 'Down': 35 };
        const dtliScore = data.dtliThumb ? THUMB_SCORES[data.dtliThumb] : null;
        const bwwScore = data.bwwThumb ? THUMB_SCORES[data.bwwThumb] : null;
        const thumbScore = dtliScore || bwwScore;

        if (thumbScore) {
          const delta = Math.abs(data.llmScore.score - thumbScore);
          if (delta > 25) {
            stats.highDeltaReviews.push({
              showId, file,
              critic: data.criticName,
              llmScore: data.llmScore.score,
              thumbScore,
              thumb: data.dtliThumb || data.bwwThumb,
              delta
            });
          }
        }
      }

      // Single-excerpt with non-low confidence
      if (data.llmMetadata?.textSource?.type === 'excerpt' ||
          data.llmMetadata?.textSource?.status === 'excerpt-only') {
        if (data.llmScore && data.llmScore.confidence !== 'low') {
          const excerpts = [data.dtliExcerpt, data.bwwExcerpt, data.showScoreExcerpt, data.nycTheatreExcerpt]
            .filter(e => e && e.length >= 30);
          const uniqueExcerpts = new Set(excerpts);
          if (uniqueExcerpts.size <= 1) {
            stats.singleExcerptNonLow.push({
              showId, file,
              critic: data.criticName,
              confidence: data.llmScore.confidence,
              score: data.llmScore.score
            });
          }
        }
      }

      // Meh thumb ignored
      if (data.mehThumbIgnored === true) {
        stats.mehThumbIgnored.push({
          showId, file,
          critic: data.criticName,
          llmScore: data.llmScore?.score,
          thumb: data.dtliThumb || data.bwwThumb
        });
      }

    } catch (e) {
      // Skip unreadable files
    }
  }
}

// Sort high-delta by delta descending, take top 20
stats.highDeltaReviews.sort((a, b) => b.delta - a.delta);
const top20Delta = stats.highDeltaReviews.slice(0, 20);

// Build report
const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    totalReviews: stats.totalReviews,
    reviewsWithScore: stats.reviewsWithScore,
    reviewsWithFullText: stats.reviewsWithFullText,
    reviewsWithLlmScore: stats.reviewsWithLlmScore,
    pctScored: stats.totalReviews > 0 ? Math.round(stats.reviewsWithScore / stats.totalReviews * 100) : 0,
    pctWithFullText: stats.totalReviews > 0 ? Math.round(stats.reviewsWithFullText / stats.totalReviews * 100) : 0,
  },
  textQuality: stats.textQuality,
  flags: {
    showNotMentioned: stats.showNotMentioned.length,
    misattributed: stats.misattributed.length,
    duplicateText: stats.duplicateText.length,
    total: stats.showNotMentioned.length + stats.misattributed.length + stats.duplicateText.length,
  },
  flaggedReviews: {
    showNotMentioned: stats.showNotMentioned,
    misattributed: stats.misattributed,
    duplicateText: stats.duplicateText,
  },
  scoringIssues: {
    highDeltaCount: stats.highDeltaReviews.length,
    top20HighDelta: top20Delta,
    singleExcerptNonLow: stats.singleExcerptNonLow.length,
    mehThumbIgnored: stats.mehThumbIgnored.length,
  },
};

// Calculate failure threshold (10% flagged)
const flagPct = stats.totalReviews > 0
  ? (report.flags.total / stats.totalReviews * 100)
  : 0;
report.flagPctOfTotal = Math.round(flagPct * 10) / 10;
report.exceedsThreshold = flagPct > 10;

// Print summary
console.log(`Total reviews: ${stats.totalReviews}`);
console.log(`  With score: ${stats.reviewsWithScore} (${report.summary.pctScored}%)`);
console.log(`  With fullText: ${stats.reviewsWithFullText} (${report.summary.pctWithFullText}%)`);
console.log(`  With LLM score: ${stats.reviewsWithLlmScore}`);
console.log('');
console.log('Text quality distribution:');
Object.entries(stats.textQuality).forEach(([k, v]) => {
  if (v > 0) console.log(`  ${k}: ${v}`);
});
console.log('');
console.log('Quality flags:');
console.log(`  showNotMentioned: ${stats.showNotMentioned.length}`);
console.log(`  misattributed: ${stats.misattributed.length}`);
console.log(`  duplicateText: ${stats.duplicateText.length}`);
console.log(`  Total flagged: ${report.flags.total} (${report.flagPctOfTotal}% of total)`);
console.log('');
console.log('Scoring issues:');
console.log(`  High-delta (LLM vs thumb >25pt): ${stats.highDeltaReviews.length}`);
console.log(`  Single-excerpt non-low confidence: ${stats.singleExcerptNonLow.length}`);
console.log(`  Meh thumb ignored: ${stats.mehThumbIgnored.length}`);

if (top20Delta.length > 0) {
  console.log('\nTop high-delta reviews:');
  for (const d of top20Delta.slice(0, 10)) {
    console.log(`  ${d.showId}: ${d.critic} — LLM=${d.llmScore}, thumb=${d.thumbScore} (${d.thumb}), Δ=${d.delta}`);
  }
}

if (!DRY_RUN) {
  // Write report
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nReport written to: ${REPORT_PATH}`);

  // Update history
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    } catch (e) {
      history = [];
    }
  }
  history.push({
    date: new Date().toISOString().split('T')[0],
    totalReviews: stats.totalReviews,
    reviewsWithScore: stats.reviewsWithScore,
    pctFullText: report.summary.pctWithFullText,
    flaggedCount: report.flags.total,
    flagPct: report.flagPctOfTotal,
    highDeltaCount: stats.highDeltaReviews.length,
  });
  // Keep last 12 months
  if (history.length > 12) history = history.slice(-12);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
} else {
  console.log('\n[DRY RUN] No files written.');
}

// Build markdown for GitHub issue
const markdown = `# Scoring Audit Report — ${new Date().toISOString().split('T')[0]}

## Summary
| Metric | Value |
|--------|-------|
| Total reviews | ${stats.totalReviews} |
| With score | ${stats.reviewsWithScore} (${report.summary.pctScored}%) |
| With full text | ${stats.reviewsWithFullText} (${report.summary.pctWithFullText}%) |
| Quality flags | ${report.flags.total} (${report.flagPctOfTotal}%) |
| High-delta reviews | ${stats.highDeltaReviews.length} |

## Quality Flags
- \`showNotMentioned\`: ${stats.showNotMentioned.length}
- \`misattributed\`: ${stats.misattributed.length}
- \`duplicateText\`: ${stats.duplicateText.length}

## Top High-Delta Reviews (LLM vs Thumb)
${top20Delta.slice(0, 10).map(d =>
  `- **${d.showId}**: ${d.critic} — LLM=${d.llmScore}, thumb=${d.thumbScore} (${d.thumb}), Δ=${d.delta}`
).join('\n') || 'None'}

## Scoring Edge Cases
- Single-excerpt with non-low confidence: ${stats.singleExcerptNonLow.length}
- Meh thumb ignored: ${stats.mehThumbIgnored.length}
`;

if (!DRY_RUN) {
  fs.writeFileSync(path.join(AUDIT_DIR, 'scoring-audit.md'), markdown);
}

// Exit with error if flags exceed 10%
if (report.exceedsThreshold) {
  console.error(`\n❌ AUDIT THRESHOLD EXCEEDED: ${report.flagPctOfTotal}% flagged (threshold: 10%)`);
  process.exit(1);
}

console.log('\n=== DONE ===');
