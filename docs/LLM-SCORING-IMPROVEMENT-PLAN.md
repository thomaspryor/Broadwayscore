# LLM Scoring Improvement Plan v2

**Revised based on critical review identifying that the original plan treated symptoms, not root causes.**

## Problem Statement

Analysis of 1,100+ reviews revealed 31% mismatch rate between LLM scores and aggregator thumbs. However, **these errors have different root causes**:

| Error Type | Example | Root Cause | % of Errors (est.) |
|------------|---------|------------|-------------------|
| Truncated input | Suffs/WashPost | Scored from 500-char excerpt, not fullText | ~40% |
| Multi-show review | Doubt/WashPost | Review covers 2+ shows, LLM conflates them | ~10% |
| Narrative misread | Various | LLM anchors on setup, misses verdict | ~25% |
| Thumbs are wrong | Just in Time | Aggregator classification is incorrect | ~15% |
| Genuine ambiguity | Mixed reviews | Review is truly mixed, both scores defensible | ~10% |

**Key insight: Fixing input quality will address ~50% of errors before any prompt changes.**

---

## Phase 1: Fix Input Quality (High Impact, Low Risk)

### 1.1 Always prefer fullText over excerpts

**Problem:** Many reviews were scored using truncated excerpts (bwwExcerpt, dtliExcerpt) even when fullText exists or was added later.

**Evidence:** Suffs/WashPost has `fullText` (4,624 chars) but `bwwExcerpt` (500 chars, truncated mid-word) was likely used for scoring. The excerpt ends before the positive verdict.

**Fix in `scripts/llm-scoring/scorer.ts`:**

```typescript
async scoreReviewFile(reviewFile: ReviewTextFile): Promise<...> {
  // CHANGED: Strict preference for fullText
  let textToScore: string;

  if (reviewFile.fullText && reviewFile.fullText.length > 200) {
    textToScore = reviewFile.fullText;
  } else if (reviewFile.showScoreExcerpt && reviewFile.showScoreExcerpt.length > 200) {
    // showScoreExcerpt is usually cleaner than others
    textToScore = reviewFile.showScoreExcerpt;
  } else {
    // Fallback to any excerpt, but mark as low confidence
    textToScore = reviewFile.dtliExcerpt || reviewFile.bwwExcerpt || '';
    // Flag that this is excerpt-only scoring
    reviewFile._scoredFromExcerpt = true;
  }

  if (textToScore.length < 100) {
    return { success: false, error: 'Insufficient text for scoring' };
  }

  // ... rest of scoring
}
```

### 1.2 Clean HTML artifacts before scoring

**Problem:** Scraped fullText contains mastheads, captions, nav elements.

**Evidence:** Suffs fullText starts with "Democracy Dies in DarknessShaina Taub as Alice Paul in 'Suffs'..." - masthead + photo caption mashed together.

**Fix - add text cleaning function:**

```typescript
function cleanReviewText(text: string): string {
  let cleaned = text;

  // Remove common mastheads
  cleaned = cleaned.replace(/^(Democracy Dies in Darkness|Subscribe to continue|Advertisement\s*)/i, '');

  // Remove photo captions (usually in parentheses after names)
  cleaned = cleaned.replace(/\([^)]*(?:Photo|Credit|Getty|AP|Reuters)[^)]*\)/gi, '');

  // Remove "Listen X min Share Comment" patterns (WashPost)
  cleaned = cleaned.replace(/Listen\d+\s*min\s*Share\s*Comment[^.]*\./gi, '');

  // Remove trailing metadata (runtime, ticket info)
  cleaned = cleaned.replace(/\n\s*(?:Running time|Tickets|At the)[^]*$/i, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}
```

### 1.3 Rescore all reviews marked needsRescore

**Problem:** Reviews have `needsRescore: true` but haven't been rescored.

**Fix:** Before any prompt changes, run rescoring on existing backlog:

```bash
# Find reviews needing rescore
node -e "
const fs = require('fs');
const path = require('path');
const dir = 'data/review-texts';
let count = 0;
fs.readdirSync(dir).forEach(show => {
  const showDir = path.join(dir, show);
  if (!fs.statSync(showDir).isDirectory()) return;
  fs.readdirSync(showDir).filter(f => f.endsWith('.json')).forEach(f => {
    const data = JSON.parse(fs.readFileSync(path.join(showDir, f)));
    if (data.needsRescore) {
      console.log(show + '/' + f);
      count++;
    }
  });
});
console.error('Total needing rescore:', count);
"
```

### 1.4 Detect and flag multi-show reviews

**Problem:** Some reviews (like Doubt/WashPost) cover multiple shows. The LLM conflates scores.

**Detection heuristics:**

```typescript
function detectMultiShowReview(text: string, targetShowTitle: string): boolean {
  // Count show title mentions vs other Broadway show mentions
  const otherShows = [
    'The Hunt', 'Doubt', 'Wicked', 'Hamilton', // etc - known current shows
  ].filter(s => s.toLowerCase() !== targetShowTitle.toLowerCase());

  let otherShowMentions = 0;
  for (const show of otherShows) {
    const regex = new RegExp(`\\b${show}\\b`, 'gi');
    const matches = text.match(regex);
    if (matches && matches.length >= 3) {
      otherShowMentions++;
    }
  }

  return otherShowMentions > 0;
}
```

**Handling:** Flag these reviews for manual scoring or skip LLM scoring entirely.

---

## Phase 2: Build Proper Test Infrastructure

### 2.1 Create stratified test set (100+ reviews)

The original plan proposed 30 reviews. This is insufficient.

**New test set requirements:**
- 150 reviews minimum
- Stratified by:
  - Error type (too low, too high, correct)
  - Outlet tier (Tier 1, 2, 3)
  - Input type (fullText vs excerpt-only)
  - Review length (short <500, medium 500-1500, long >1500)

**Human verification:** For test set reviews, manually verify the "correct" score. Don't assume thumbs are right.

### 2.2 Define meaningful metrics

**Replace "80% accuracy vs thumbs" with:**

| Metric | Definition | Target |
|--------|------------|--------|
| Recommendation flip rate | How often LLM thumb differs from human-verified thumb | <15% |
| Severe error rate | Score differs by >25 points from human-verified | <5% |
| Excerpt penalty | Additional error rate for excerpt-only vs fullText | <10% difference |

### 2.3 Establish statistical significance requirements

- Minimum 100 reviews per test condition
- Report 95% confidence intervals
- Require p<0.05 for claiming improvement

---

## Phase 3: Targeted Prompt Improvements (After Phase 1 & 2)

### 3.1 Simpler prompt addition (not section weighting)

Instead of complex section splitting, add a **pre-check step**:

**Add to SYSTEM_PROMPT:**

```
## Pre-Scoring Checklist

Before assigning a score, verify:

1. **CURRENT vs PREVIOUS production**: Is negative language about a previous version,
   revival, or different production? If so, focus on what the critic says about THIS production.

2. **FINAL VERDICT**: What does the critic explicitly recommend in the final 2-3 sentences?
   Look for: "worth seeing", "skip it", "essential", "disappointing", "recommended"

3. **MULTIPLE SHOWS**: Does this review cover more than one show? If yes, score ONLY
   the portions about the target show.

If the opening is negative but the final verdict is positive, this is a POSITIVE review.
Score based on the verdict, not the setup.
```

**This is ~150 tokens vs ~500 tokens for section weighting, and directly addresses the failure modes.**

### 3.2 Add one new few-shot example

Add the Suffs case as an explicit calibration example:

```typescript
{
  reviewExcerpt: `When "Suffs" premiered at the Public Theatre two years ago, it was a didactic, dull, overstuffed mess. That it would come back, and on Broadway, wasn't a thrilling prospect. And while it did not magically morph into a great show, Version 2.0 is tighter, more confident, often rousing and downright entertaining. We can only rejoice that the creative team did not back down. What "Suffs" does capture is the excitement and urgency of being swept up in the fight for a just cause.`,
  score: 78,
  bucket: 'Positive',
  reasoning: 'The negative opening describes the PREVIOUS production ("two years ago"). The verdict for THIS production is clear: "rousing and downright entertaining", "We can only rejoice". Score the current production, not the old one.'
}
```

### 3.3 Add confidence modifier for excerpt-only scoring

```typescript
// In scorer.ts, after scoring:
if (reviewFile._scoredFromExcerpt) {
  result.confidence = 'low';  // Force low confidence for excerpt-only
  result.reasoning += ' [Scored from excerpt only - lower confidence]';
}
```

---

## Phase 4: Thumb Override Strategy (Revised)

### 4.1 Don't treat thumbs as ground truth

**Original plan:** Always override low-confidence LLM scores with thumbs.

**Problem:** Thumbs are also wrong ~15% of the time (Just in Time example).

**Revised approach:**

```typescript
function resolveScore(llmScore, llmConfidence, dtliThumb, bwwThumb) {
  const thumbsAgree = dtliThumb && bwwThumb && dtliThumb === bwwThumb;
  const llmThumb = scoreToThumb(llmScore);

  // Case 1: High confidence LLM, use it
  if (llmConfidence === 'high') {
    return { score: llmScore, source: 'llm-high' };
  }

  // Case 2: Both thumbs agree and differ from LLM - flag for review
  if (thumbsAgree && llmThumb !== dtliThumb) {
    return {
      score: llmScore,  // Keep LLM score but flag
      source: 'llm-flagged',
      needsReview: true,
      reviewReason: `LLM (${llmThumb}) disagrees with both aggregators (${dtliThumb})`
    };
  }

  // Case 3: Low confidence, one thumb available - use thumb
  if (llmConfidence === 'low' && (dtliThumb || bwwThumb)) {
    const thumb = dtliThumb || bwwThumb;
    return { score: THUMB_TO_SCORE[thumb], source: 'thumb-lowconf' };
  }

  // Case 4: Medium confidence, thumbs disagree - use LLM
  return { score: llmScore, source: 'llm-medium' };
}
```

### 4.2 Build human review queue

Instead of auto-overriding, create a queue for manual review:

```typescript
// Flag reviews where LLM and thumbs strongly disagree
if (Math.abs(llmScore - expectedThumbScore) > 25) {
  review.needsHumanReview = true;
  review.humanReviewReason = 'Large score discrepancy';
}
```

**Output:** `data/audit/needs-human-review.json` - reviews to manually verify.

---

## Phase 5: Validation & Rollout

### 5.1 Validation sequence

```
1. Run Phase 1 fixes (input quality)
   → Measure: How many previously-misscored reviews now score correctly?
   → Expected: 30-40% of errors fixed

2. Build test set (Phase 2)
   → Human-verify 150 reviews
   → Establish baseline metrics

3. Test prompt changes (Phase 3) on test set
   → Require: Statistically significant improvement
   → Require: <5% regression on previously-correct reviews

4. Gradual rollout
   → Score new reviews with new prompt
   → Monitor thumb match rate for 2 weeks
   → If regression, rollback
```

### 5.2 Rollback strategy

```typescript
// All reviews store prompt version
llmMetadata: {
  promptVersion: '4.0.0',
  previousScore: 78,  // Score from v3
  previousVersion: '3.0.0'
}
```

If v4 is worse, can restore v3 scores without re-running LLM.

---

## Files to Modify

| File | Changes | Phase |
|------|---------|-------|
| `scripts/llm-scoring/scorer.ts` | Prefer fullText, clean text, excerpt flag | 1 |
| `scripts/llm-scoring/config.ts` | Add pre-check prompt, new few-shot example | 3 |
| `scripts/rebuild-all-reviews.js` | Revised thumb override logic | 4 |

## Files to Create

| File | Purpose | Phase |
|------|---------|-------|
| `scripts/llm-scoring/text-cleaner.ts` | HTML/artifact cleaning | 1 |
| `scripts/llm-scoring/multi-show-detector.ts` | Detect multi-show reviews | 1 |
| `scripts/audit-rescore-backlog.js` | Find reviews needing rescore | 1 |
| `data/audit/test-set-150.json` | Human-verified test set | 2 |
| `data/audit/needs-human-review.json` | Review queue for discrepancies | 4 |

---

## Success Criteria (Revised)

| Metric | Current | After Phase 1 | After Phase 3 |
|--------|---------|---------------|---------------|
| Recommendation flip rate | 31% | 20% | 15% |
| Severe errors (>25 pts) | ~8% | 5% | 3% |
| Excerpt-only accuracy | ~50% | N/A (rescore with fullText) | 65%+ |
| Flagged for human review | 0 | N/A | ~50 reviews |

---

## Key Differences from v1 Plan

| Aspect | v1 Plan | v2 Plan |
|--------|---------|---------|
| Root cause | "Narrative structure" | Multiple causes: truncation, multi-show, narrative, bad thumbs |
| First action | Change prompt | Fix input quality |
| Section weighting | 50%/35%/15% arbitrary | Removed - too fragile |
| Prompt change | +500 tokens, complex | +150 tokens, simple pre-check |
| Thumbs | Treat as ground truth | Treat as fallible signal |
| Test set | 30 reviews | 150+ reviews, human-verified |
| Rollback | Vague | Explicit version tracking |

---

## Execution Order

```
Week 1:
  - Implement text cleaning (1.2)
  - Implement fullText preference (1.1)
  - Run rescore backlog audit (1.3)
  - Implement multi-show detection (1.4)

Week 2:
  - Build 150-review test set with human verification (2.1)
  - Establish baseline metrics (2.2)
  - Rescore backlog with cleaned inputs

Week 3:
  - Implement prompt pre-check (3.1)
  - Add new few-shot example (3.2)
  - Test on test set, measure improvement

Week 4:
  - Implement revised thumb override (4.1)
  - Build human review queue (4.2)
  - Gradual rollout if tests pass
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Text cleaning removes valid content | Test cleaner on 50 reviews manually first |
| Multi-show detector has false positives | Flag only, don't auto-skip |
| Prompt changes cause regression | Test on 150-review set before deploying |
| Human review queue grows too large | Set threshold (flag only >25pt discrepancy) |
| Phase 1 fixes don't help | Still valuable - cleaner data for future |
