#!/usr/bin/env node
/**
 * fix-non-review-misclassifications.js
 *
 * Finds review-text files incorrectly flagged as isNonReview:true that are
 * actually real reviews. Uses multiple signals to build confidence:
 * - URL contains /review/ or /reviews/
 * - Critic is a known theater critic
 * - Content tier is "complete" with 200+ words
 * - Has a valid LLM score
 *
 * Run with --dry-run (default) to see what would change.
 * Run with --fix to actually modify files.
 */

const fs = require('fs');
const path = require('path');

const dryRun = !process.argv.includes('--fix');
const verbose = process.argv.includes('--verbose');

const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

// Known theater critics who definitely write reviews
const KNOWN_CRITICS = new Set([
  'ben brantley', 'jesse green', 'elisabeth vincentelli', 'alexis soloski',
  'laura collins-hughes', 'maya phillips', 'jesse green',
  'hilton als', 'helen shaw', 'sara holdren', 'jackson mchenry',
  'david rooney', 'angie han', 'frank rizzo',
  'marilyn stasio', 'gordon cox',
  'rex reed', 'david fear',
  'adam feldman', 'zachary stewart', 'hayley levitt',
  'johnny oleksinski', 'michael riedel',
  'terry teachout', 'linda winer',
  'tim teeman', 'david cote',
  'mark kennedy', 'peter marks',
  'melissa rose bernardo',
  'chris jones', 'charles mcnulty',
  'matt windman', 'joe dziemianowicz',
  'roma torre', 'brian scott lipton',
  'david sheward', 'matthew murray',
  'arifa akbar', 'matt wolf', 'adrian horton',
  'michael billington', 'dominic cavendish',
  'michael dale', 'deirdre donovan', 'noah simon jampol',
  'thom geier', 'leah greenblatt',
  'patrick ryan', 'greg evans',
  'daz gale', 'kate soper', 'taylor vaughan',
  'alicia kort', 'stephanie zacharek',
  'brittany crowell', 'lane williamson',
  'emily shire', 'tanner stransky',
  'lauren giella',
]);

// Outlets that primarily publish reviews (not news)
const REVIEW_OUTLETS = new Set([
  'nytimes', 'vulture', 'variety', 'hollywood-reporter', 'theatermania',
  'nypost', 'newyorker', 'timeout', 'observer', 'ew', 'newsday',
  'nydailynews', 'wsj', 'washpost', 'guardian', 'dailybeast',
  'rollingstone', 'paste-magazine', 'billboard', 'talkinbroadway',
  'theater-scene', 'amny', 'broadwayworld', 'theatrely',
  'thestage', 'whatsonstage', 'standard', 'telegraph',
  'times-uk', 'timeout-london',
]);

const results = { fixed: [], skipped: [], errors: [] };

// Walk all show directories
const showDirs = fs.readdirSync(reviewTextsDir).filter(d => {
  const fullPath = path.join(reviewTextsDir, d);
  return fs.statSync(fullPath).isDirectory();
});

for (const showDir of showDirs) {
  const dirPath = path.join(reviewTextsDir, showDir);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // Skip unparseable files
    }

    // Only look at isNonReview:true files
    if (data.isNonReview !== true) continue;

    // Build confidence signals
    const signals = [];
    let confidence = 0;

    // Signal 1: URL contains /review/ or /reviews/
    const url = (data.url || '').toLowerCase();
    if (/\/reviews?\//.test(url)) {
      signals.push('url-has-review');
      confidence += 3;
    }

    // Signal 2: Known theater critic
    const critic = (data.criticName || '').toLowerCase().trim();
    if (KNOWN_CRITICS.has(critic)) {
      signals.push(`known-critic:${critic}`);
      confidence += 3;
    }

    // Signal 3: Complete content with substantial word count
    const wordCount = data.textWordCount || data.wordCount || 0;
    if (data.contentTier === 'complete' && wordCount >= 200) {
      signals.push(`complete-${wordCount}w`);
      confidence += 2;
    } else if (data.contentTier === 'complete') {
      signals.push('complete');
      confidence += 1;
    }

    // Signal 4: Known review outlet
    const outletId = (data.outletId || '').toLowerCase();
    if (REVIEW_OUTLETS.has(outletId)) {
      signals.push(`review-outlet:${outletId}`);
      confidence += 2;
    }

    // Signal 5: Has a high-confidence LLM score
    if (data.llmScore && data.llmScore.confidence === 'high') {
      signals.push('high-conf-llm');
      confidence += 1;
    }

    // Signal 6: nonReviewType is actually "review" (contradicts isNonReview)
    if (data.nonReviewType === 'review') {
      signals.push('self-contradicting');
      confidence += 2;
    }

    // Negative signals — reduce confidence
    // Interviews and profiles from TheaterMania are often not reviews
    if (data.nonReviewType === 'interview' && outletId === 'theatermania') {
      signals.push('tm-interview-pattern');
      confidence -= 2;
    }

    // Garbage text detection: tag pages, listing pages, search results
    const textStart = (data.fullText || '').substring(0, 300).toLowerCase();
    if (/displaying all articles|tagged:|related articles|search results|browse by/i.test(textStart)) {
      signals.push('garbage-text-pattern');
      confidence -= 5;
    }

    // No fullText and no substantial excerpt — can't verify content
    const hasSubstantialText = (data.fullText && data.fullText.length > 200) ||
      (data.showScoreExcerpt && data.showScoreExcerpt.length > 50) ||
      (data.bwwExcerpt && data.bwwExcerpt.length > 50);
    if (!hasSubstantialText) {
      signals.push('no-substantial-text');
      confidence -= 2;
    }

    // Require at least one content-based signal (URL or content tier)
    // Critic name + LLM confidence alone is not enough — wrong URLs get assigned to known critics
    const hasContentSignal = signals.some(s =>
      s === 'url-has-review' || s.startsWith('complete-') || s === 'complete' || s === 'self-contradicting'
    );
    if (!hasContentSignal) {
      confidence = Math.min(confidence, 3); // Cap at below threshold
    }

    // Only fix if confidence >= 4 (at least 2 strong signals including content)
    if (confidence < 4) {
      if (verbose && confidence >= 2) {
        console.log(`  BORDERLINE (${confidence}): ${showDir}/${file} — ${signals.join(', ')}`);
      }
      continue;
    }

    const score = data.assignedScore || data.llmScore?.score || '?';
    const entry = {
      file: `${showDir}/${file}`,
      outlet: outletId,
      critic: data.criticName || 'unknown',
      score,
      confidence,
      signals,
    };

    if (dryRun) {
      results.fixed.push(entry);
      console.log(`[WOULD FIX] ${entry.file} | ${entry.outlet}/${entry.critic} | score=${score} | confidence=${confidence} | ${signals.join(', ')}`);
    } else {
      try {
        data.isNonReview = false;
        data.nonReviewOverride = `Auto-recovered: confidence=${confidence}, signals=[${signals.join(',')}]`;
        data.nonReviewOverrideAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        results.fixed.push(entry);
        console.log(`[FIXED] ${entry.file} | ${entry.outlet}/${entry.critic} | score=${score}`);
      } catch (e) {
        results.errors.push({ file: entry.file, error: e.message });
        console.error(`[ERROR] ${entry.file}: ${e.message}`);
      }
    }
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`${dryRun ? 'Would fix' : 'Fixed'}: ${results.fixed.length} misclassified reviews`);
if (results.errors.length) console.log(`Errors: ${results.errors.length}`);
if (dryRun && results.fixed.length > 0) {
  console.log(`\nRun with --fix to apply changes`);

  // Show breakdown by outlet
  const byOutlet = {};
  for (const r of results.fixed) {
    byOutlet[r.outlet] = (byOutlet[r.outlet] || 0) + 1;
  }
  console.log(`\nBy outlet:`);
  Object.entries(byOutlet).sort((a, b) => b[1] - a[1]).forEach(([o, c]) => {
    console.log(`  ${o}: ${c}`);
  });
}
