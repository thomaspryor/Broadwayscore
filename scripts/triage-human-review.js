#!/usr/bin/env node
/**
 * Triage human review queue items
 * Reads each flagged review's text file, checks current score in reviews.json,
 * and categorizes into actionable resolution buckets
 */

const fs = require('fs');
const path = require('path');

const auditPath = path.join(__dirname, '../data/audit/needs-human-review.json');
const reviewsPath = path.join(__dirname, '../data/reviews.json');

const audit = JSON.parse(fs.readFileSync(auditPath, 'utf-8'));
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));

const results = {
  // LLM scored on excerpt only + low conf → thumbs are right, no action (already overridden)
  thumbCorrect: [],
  // LLM scored on full text with high conf → LLM likely right, no fix needed
  llmCorrect: [],
  // LLM Pan (25) on excerpt with high conf → suspicious, thumbs probably better
  suspiciousLlmPan: [],
  // Both thumbs Meh vs LLM high-conf Down (42-54) — borderline, needs manual
  borderlineMehDown: [],
  // Both thumbs Up vs LLM Flat/Down — LLM may be wrong
  thumbsUpLlmLow: [],
  // Other / complex
  other: []
};

for (const item of audit.reviews) {
  // Find the review-text file
  const showDir = path.join(__dirname, '../data/review-texts', item.showId);
  let textData = null;
  let textFile = null;

  if (fs.existsSync(showDir)) {
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf-8'));
        const outletMatch = (data.outletId || '').toLowerCase() === (item.outletId || '').toLowerCase();
        if (outletMatch) {
          textData = data;
          textFile = f;
          break;
        }
      } catch (e) { /* skip */ }
    }
  }

  // Find current score in reviews.json
  const currentReview = reviewsData.reviews.find(r =>
    r.showId === item.showId &&
    (r.outletId || '').toLowerCase() === (item.outletId || '').toLowerCase()
  );
  const currentScore = currentReview ? currentReview.assignedScore : null;

  const entry = {
    showId: item.showId,
    outlet: item.outletId,
    critic: item.criticName,
    reason: item.reason,
    llmScore: item.llmScore,
    llmConf: item.llmConfidence,
    dtliThumb: item.dtliThumb,
    bwwThumb: item.bwwThumb,
    currentScore,
    textSource: textData ? (textData.llmMetadata?.textSource?.type || 'unknown') : 'no-file',
    hasFullText: textData ? (textData.fullText && textData.fullText.length > 200) : false,
    fullTextLen: textData ? (textData.fullText ? textData.fullText.length : 0) : 0,
    isFullReview: textData ? textData.isFullReview : false,
    contentTier: textData ? textData.contentTier : null,
    textFile
  };

  // Categorize
  if (item.reason === 'thumb-override-large-delta') {
    // These are ALREADY using thumb score in reviews.json (low/medium conf LLM)
    // The flag is informational — thumb override IS the fix
    if (item.llmConfidence === 'low') {
      entry.resolution = 'Already using thumb override (low conf LLM). No action needed.';
      results.thumbCorrect.push(entry);
    } else if (item.llmConfidence === 'high' && item.llmScore <= 30) {
      entry.resolution = 'High-conf LLM Pan, but thumb disagrees. Check review text.';
      results.suspiciousLlmPan.push(entry);
    } else {
      // medium conf with large delta — thumb override is reasonable
      entry.resolution = 'Thumb override applied (medium conf). Verify makes sense.';
      results.thumbCorrect.push(entry);
    }
  } else if (item.reason === 'both-thumbs-disagree-with-llm') {
    const bothMeh = (item.dtliThumb === 'Meh' || item.dtliThumb === 'Flat') &&
                    (item.bwwThumb === 'Meh' || item.bwwThumb === 'Flat');
    const bothUp = item.dtliThumb === 'Up' && item.bwwThumb === 'Up';

    if (bothUp) {
      // Both say Up, LLM says Mixed/Negative — thumbs probably right
      entry.resolution = 'Both thumbs Up, LLM lower. May need score bump.';
      results.thumbsUpLlmLow.push(entry);
    } else if (bothMeh && item.llmScore <= 30) {
      // LLM says Pan but both thumbs say Meh — LLM likely too harsh
      entry.resolution = 'LLM Pan on Meh review. Likely too harsh.';
      results.suspiciousLlmPan.push(entry);
    } else if (bothMeh && item.llmScore >= 31 && item.llmScore <= 54) {
      // Borderline: LLM says Negative, thumbs say Meh
      if (entry.hasFullText && entry.fullTextLen > 500 && item.llmConfidence === 'high') {
        entry.resolution = 'High-conf LLM on full text vs Meh thumbs. LLM probably more accurate.';
        results.llmCorrect.push(entry);
      } else {
        entry.resolution = 'LLM Negative vs Meh thumbs. Borderline case.';
        results.borderlineMehDown.push(entry);
      }
    } else if (bothMeh && item.llmScore >= 70) {
      // LLM says Positive but both thumbs say Meh — LLM may be too generous
      if (entry.hasFullText && item.llmConfidence === 'high') {
        entry.resolution = 'High-conf LLM Positive on full text. LLM probably right.';
        results.llmCorrect.push(entry);
      } else {
        entry.resolution = 'LLM Positive vs Meh thumbs. Check text quality.';
        results.other.push(entry);
      }
    } else {
      entry.resolution = 'Complex disagreement. Needs manual review.';
      results.other.push(entry);
    }
  }
}

// Print summary
console.log('=== HUMAN REVIEW QUEUE TRIAGE ===\n');
console.log(`Total flagged: ${audit.reviews.length}\n`);

console.log(`✓ Thumb override correct (no action): ${results.thumbCorrect.length}`);
for (const r of results.thumbCorrect) {
  console.log(`  ${r.showId} / ${r.outlet} — LLM=${r.llmScore}(${r.llmConf}), thumbs=${r.dtliThumb||'-'}/${r.bwwThumb||'-'}, current=${r.currentScore}`);
}

console.log(`\n✓ LLM correct (high-conf full text): ${results.llmCorrect.length}`);
for (const r of results.llmCorrect) {
  console.log(`  ${r.showId} / ${r.outlet} — LLM=${r.llmScore}(${r.llmConf}), thumbs=${r.dtliThumb||'-'}/${r.bwwThumb||'-'}, current=${r.currentScore}, text=${r.fullTextLen}chars`);
}

console.log(`\n⚠ Suspicious LLM Pan (25) — likely too harsh: ${results.suspiciousLlmPan.length}`);
for (const r of results.suspiciousLlmPan) {
  console.log(`  ${r.showId} / ${r.outlet} — LLM=${r.llmScore}(${r.llmConf}), thumbs=${r.dtliThumb||'-'}/${r.bwwThumb||'-'}, current=${r.currentScore}, textSrc=${r.textSource}`);
}

console.log(`\n⚠ Both thumbs Up, LLM lower — may need bump: ${results.thumbsUpLlmLow.length}`);
for (const r of results.thumbsUpLlmLow) {
  console.log(`  ${r.showId} / ${r.outlet} — LLM=${r.llmScore}(${r.llmConf}), current=${r.currentScore}, text=${r.fullTextLen}chars`);
}

console.log(`\n? Borderline Meh vs Down: ${results.borderlineMehDown.length}`);
for (const r of results.borderlineMehDown) {
  console.log(`  ${r.showId} / ${r.outlet} — LLM=${r.llmScore}(${r.llmConf}), current=${r.currentScore}, textSrc=${r.textSource}, fullText=${r.fullTextLen}`);
}

console.log(`\n? Other/complex: ${results.other.length}`);
for (const r of results.other) {
  console.log(`  ${r.showId} / ${r.outlet} — LLM=${r.llmScore}(${r.llmConf}), thumbs=${r.dtliThumb||'-'}/${r.bwwThumb||'-'}, current=${r.currentScore} — ${r.resolution}`);
}

// Calculate how many need fixing
const needsFix = results.suspiciousLlmPan.length + results.thumbsUpLlmLow.length;
const borderline = results.borderlineMehDown.length + results.other.length;
const noAction = results.thumbCorrect.length + results.llmCorrect.length;
console.log(`\n=== SUMMARY ===`);
console.log(`No action needed: ${noAction}`);
console.log(`Likely needs fix: ${needsFix}`);
console.log(`Borderline/manual: ${borderline}`);

// Write actionable fixes to file
const fixes = [];

// Fix 1: Suspicious LLM Pan scores — override to thumb score
for (const r of results.suspiciousLlmPan) {
  const thumbScore = r.dtliThumb === 'Up' ? 80 : (r.dtliThumb === 'Meh' || r.dtliThumb === 'Flat') ? 60 : r.bwwThumb === 'Up' ? 80 : (r.bwwThumb === 'Meh' || r.bwwThumb === 'Flat') ? 60 : 55;
  fixes.push({
    showId: r.showId,
    outletId: r.outlet,
    action: 'override-score',
    oldScore: r.llmScore,
    newScore: thumbScore,
    reason: `LLM Pan (${r.llmScore}) too harsh for ${r.dtliThumb||r.bwwThumb} review. Override to thumb-based ${thumbScore}.`
  });
}

// Fix 2: Both thumbs Up but LLM scored low — override if current score < 70
for (const r of results.thumbsUpLlmLow) {
  if (r.currentScore < 70) {
    fixes.push({
      showId: r.showId,
      outletId: r.outlet,
      action: 'override-score',
      oldScore: r.currentScore,
      newScore: 80,
      reason: `Both thumbs Up but current score ${r.currentScore}. Override to thumb-based 80.`
    });
  }
}

fs.writeFileSync(
  path.join(__dirname, '../data/audit/human-review-fixes.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), fixes }, null, 2)
);

console.log(`\nWrote ${fixes.length} actionable fixes to data/audit/human-review-fixes.json`);
