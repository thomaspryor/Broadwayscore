#!/usr/bin/env node
/**
 * Test the per-file rejection logging logic directly.
 *
 * We can't easily run the TypeScript scorer (needs API key).
 * Instead, extract the isScoreable + logging logic and test against
 * real review files with known blocking flags.
 */

const fs = require('fs');
const path = require('path');

// Replicate isScoreable from scripts/llm-scoring/is-scoreable.ts
const EXCERPT_FIELDS = ['bwwExcerpt', 'dtliExcerpt', 'showScoreExcerpt', 'nycTheatreExcerpt', 'playbillVerdictExcerpt'];
function hasAnyExcerpt(d) {
  return EXCERPT_FIELDS.some(f => d[f] && typeof d[f] === 'string' && d[f].length > 0);
}
function isScoreable(data) {
  if (data.duplicateOf || data.wrongShow || data.wrongProduction || data.wrongAttribution || data.contentTier === 'invalid') return false;
  if (data.incompleteReason === 'scraper_garbage') return false;
  if (data.fullTextWrongAuthor) {
    if (!hasAnyExcerpt(data)) return false;
  }
  if (data.isRoundupArticle) return false;
  if (data.rejectionReason) return false;
  if (data.showNotMentioned) {
    if (!hasAnyExcerpt(data)) return false;
  }
  return true;
}

// Replicate the per-file logging logic from our index.ts change
function buildRejectionReason(d) {
  const reasons = [];
  if (d.duplicateOf) reasons.push(`duplicateOf=${d.duplicateOf}`);
  if (d.wrongShow) reasons.push('wrongShow');
  if (d.wrongProduction) reasons.push('wrongProduction');
  if (d.wrongAttribution) reasons.push('wrongAttribution');
  if (d.contentTier === 'invalid') reasons.push('contentTier=invalid');
  if (d.incompleteReason === 'scraper_garbage') reasons.push('scraper_garbage');
  if (d.isRoundupArticle) reasons.push('isRoundupArticle');
  if (d.rejectionReason) reasons.push(`rejectionReason=${d.rejectionReason}`);
  if (d.showNotMentioned) reasons.push('showNotMentioned-no-excerpts');
  if (d.fullTextWrongAuthor) reasons.push('fullTextWrongAuthor-no-excerpts');
  return reasons.join(', ') || 'unknown';
}

function main() {
  const dir = fs.existsSync('data/review-texts')
    ? 'data/review-texts'
    : '/Users/tompryor/Broadwayscore/data/review-texts';

  // Sample: 500 files, count how many are rejected and log reasons
  let total = 0, scoreable = 0, rejected = 0;
  const reasonCounts = {};
  const withoutReasonCount = { total: 0, examples: [] };

  const showDirs = fs.readdirSync(dir).filter(d => {
    try { return fs.statSync(path.join(dir, d)).isDirectory(); } catch { return false; }
  }).slice(0, 50);

  for (const showDir of showDirs) {
    const fullDir = path.join(dir, showDir);
    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      if (total >= 1000) break;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(fullDir, f), 'utf8'));
        total++;
        if (isScoreable(data)) {
          scoreable++;
        } else {
          rejected++;
          const reason = buildRejectionReason(data);
          reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
          if (reason === 'unknown') {
            withoutReasonCount.total++;
            if (withoutReasonCount.examples.length < 3) {
              withoutReasonCount.examples.push({
                file: `${showDir}/${f}`,
                flags: Object.keys(data).filter(k =>
                  ['duplicateOf','wrongShow','wrongProduction','wrongAttribution','contentTier','incompleteReason','isRoundupArticle','rejectionReason','showNotMentioned','fullTextWrongAuthor'].includes(k)
                ).map(k => `${k}=${JSON.stringify(data[k])}`),
              });
            }
          }
        }
      } catch {}
    }
    if (total >= 1000) break;
  }

  console.log(`Total files scanned: ${total}`);
  console.log(`Scoreable: ${scoreable} (${(scoreable/total*100).toFixed(1)}%)`);
  console.log(`Rejected: ${rejected} (${(rejected/total*100).toFixed(1)}%)`);
  console.log('\nRejection reasons (top 10):');
  const sorted = Object.entries(reasonCounts).sort((a,b) => b[1] - a[1]);
  for (const [reason, count] of sorted.slice(0, 10)) {
    console.log(`  ${count.toString().padStart(4)}  ${reason}`);
  }

  // The key assertion: every rejected file should have a NON-"unknown" reason.
  // "unknown" means our logging missed a flag combination.
  console.log(`\nRejected files with unexplained reason ("unknown"): ${withoutReasonCount.total}`);
  if (withoutReasonCount.examples.length > 0) {
    console.log('Examples:');
    withoutReasonCount.examples.forEach(e => {
      console.log(`  ${e.file}`);
      console.log(`    flags: ${e.flags.join(', ')}`);
    });
  }

  const pass = withoutReasonCount.total === 0;
  console.log(`\nResult: ${pass ? 'PASS — every rejection has a clear reason' : 'FAIL — some rejections have no explanation'}`);
  process.exit(pass ? 0 : 1);
}

main();
