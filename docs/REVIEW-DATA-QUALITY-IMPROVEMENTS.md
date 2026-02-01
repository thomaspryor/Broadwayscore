# Review Data Quality Improvements

## Root Cause Analysis

### Issue: LLM Scored Garbage 404 Page Text

**What happened:**
- NYSR review URLs returned 404 pages ("The page you are looking for no longer exists")
- The 404 page contained snippets of OTHER reviews (Joshua Henry/Purlie, Lesley Manville/Ghosts)
- LLM scoring scored the garbage text and gave wrong scores (75 instead of 40)
- Later, garbage detection ran and cleared the text, but didn't invalidate the LLM score

**Why it happened:**
1. `scripts/llm-scoring/index.ts` has **simplified inline garbage detection** that doesn't use the full `content-quality.js` module
2. The inline check `lower.includes('page not found')` doesn't match `"The page you are looking for no longer exists"`
3. No **show title validation** - the garbage text didn't mention the actual show
4. No **post-garbage invalidation** - when garbage is detected after scoring, the score isn't flagged as invalid

---

## Required Fixes

### Fix 1: Use Full Content-Quality Module in LLM Scoring

**File:** `scripts/llm-scoring/index.ts`

**Problem:** `getScorableText()` has its own simplified garbage detection

**Current (bad):**
```typescript
const isErrorPage = lower.includes('page not found') ||
                    lower.includes('404') ||
                    lower.includes('access denied');
```

**Should be:**
```typescript
// Import at top of file (already imported but not used!)
const { assessTextQuality, isGarbageContent } = require('../lib/content-quality.js');

// In getScorableText():
const qualityCheck = assessTextQuality(data.fullText, showTitle);
if (qualityCheck.quality === 'garbage') {
  console.log(`  Skipping garbage fullText: ${qualityCheck.issues.join(', ')}`);
  // Fall back to excerpts
}
```

### Fix 2: Add Show Title Validation

**File:** `scripts/lib/content-quality.js`

**Add new function:**
```javascript
/**
 * Validate that text mentions the expected show
 * @param {string} text - Review text
 * @param {string} showTitle - Expected show title
 * @param {string} showId - Show ID for alternative matching
 * @returns {{ valid: boolean, reason: string }}
 */
function validateShowMentioned(text, showTitle, showId) {
  if (!text || text.length < 100) {
    return { valid: false, reason: 'Text too short to validate' };
  }

  const lower = text.toLowerCase();

  // Check for show title
  if (showTitle) {
    const titleLower = showTitle.toLowerCase();
    if (lower.includes(titleLower)) {
      return { valid: true, reason: 'Show title found' };
    }

    // Check title words (for multi-word titles)
    const words = titleLower.split(/\s+/).filter(w => w.length > 3);
    if (words.length > 1 && words.every(w => lower.includes(w))) {
      return { valid: true, reason: 'Show title words found' };
    }
  }

  // Check for showId patterns (e.g., "back to the future" for "back-to-the-future-2023")
  if (showId) {
    const idWords = showId.replace(/-\d{4}$/, '').split('-').filter(w => w.length > 2);
    if (idWords.length >= 2 && idWords.every(w => lower.includes(w))) {
      return { valid: true, reason: 'Show ID words found' };
    }
  }

  return { valid: false, reason: 'Show title not mentioned in text' };
}
```

**Use in LLM scoring:**
```typescript
const showValidation = validateShowMentioned(text, showTitle, showId);
if (!showValidation.valid) {
  console.log(`  Warning: ${showValidation.reason}`);
  // Either skip or flag for review
}
```

### Fix 3: Detect Multi-Show Garbage Text

The NYSR 404 page contained reviews of MULTIPLE OTHER shows. This is a red flag.

**Add detection:**
```javascript
/**
 * Detect if text contains references to multiple different shows
 * (indicates 404 page or navigation junk)
 */
function detectMultiShowContent(text) {
  // List of specific show titles that shouldn't appear together
  const CURRENT_SHOWS = [
    'purlie', 'ghosts', 'maybe happy ending', 'death becomes her',
    'stereophonic', 'cabaret', 'sunset boulevard', 'the outsiders',
    // ... more current shows
  ];

  const lower = text.toLowerCase();
  const foundShows = CURRENT_SHOWS.filter(show => lower.includes(show));

  if (foundShows.length >= 3) {
    return {
      detected: true,
      reason: `Multiple shows mentioned: ${foundShows.join(', ')}`
    };
  }

  return { detected: false };
}
```

### Fix 4: Post-Garbage Score Invalidation

**File:** `scripts/fix-garbage-scores.js` (new)

When garbage is detected in a review that already has an LLM score:
1. Move `llmScore` to `_invalidatedLlmScore`
2. Add `needsRescore: true`
3. If explicit score exists, use that as `assignedScore`

```javascript
// In the garbage cleanup process:
if (review.garbageFullText && review.llmScore) {
  // The LLM score was based on garbage - invalidate it
  review._invalidatedLlmScore = {
    ...review.llmScore,
    reason: review.garbageReason,
    invalidatedAt: new Date().toISOString()
  };
  delete review.llmScore;
  review.needsRescore = true;

  // If we have explicit score, use that
  if (review.originalScoreNormalized) {
    review.assignedScore = review.originalScoreNormalized;
  }
}
```

### Fix 5: Pre-Scoring Validation Pipeline

Before scoring any review, run this validation:

```typescript
interface PreScoringValidation {
  canScore: boolean;
  warnings: string[];
  textSource: 'fullText' | 'excerpts' | 'none';
}

function validateBeforeScoring(review: ReviewTextFile, showTitle: string): PreScoringValidation {
  const warnings: string[] = [];

  // 1. Check if fullText is garbage
  if (review.fullText) {
    const garbageCheck = isGarbageContent(review.fullText);
    if (garbageCheck.isGarbage) {
      warnings.push(`fullText is garbage: ${garbageCheck.reason}`);
    }
  }

  // 2. Check if fullText mentions the show
  if (review.fullText && review.fullText.length > 200) {
    const showCheck = validateShowMentioned(review.fullText, showTitle, review.showId);
    if (!showCheck.valid) {
      warnings.push(showCheck.reason);
    }
  }

  // 3. Check for multi-show content
  if (review.fullText) {
    const multiShow = detectMultiShowContent(review.fullText);
    if (multiShow.detected) {
      warnings.push(multiShow.reason);
    }
  }

  // 4. Check text quality status
  if (review.textStatus === 'garbage_cleared') {
    warnings.push('Previous garbage text was cleared');
  }

  // Determine if we can score
  const hasValidFullText = review.fullText && warnings.length === 0;
  const hasExcerpts = review.bwwExcerpt || review.dtliExcerpt || review.showScoreExcerpt;

  return {
    canScore: hasValidFullText || hasExcerpts,
    warnings,
    textSource: hasValidFullText ? 'fullText' : (hasExcerpts ? 'excerpts' : 'none')
  };
}
```

### Fix 6: Explicit Score Priority

When a review has an explicit critic score (stars, letter grade), prioritize it:

```typescript
function determineAssignedScore(review: ReviewTextFile, llmScore: number): number {
  // Explicit scores are more reliable than LLM
  if (review.originalScoreNormalized !== null && review.originalScoreNormalized !== undefined) {
    const delta = Math.abs(llmScore - review.originalScoreNormalized);

    if (delta > 20) {
      console.log(`  Warning: LLM (${llmScore}) differs from explicit (${review.originalScoreNormalized}) by ${delta} points`);
      // Trust explicit score
      return review.originalScoreNormalized;
    }
  }

  return llmScore;
}
```

---

## Implementation Priority

### High Priority (Do First)

1. **Fix LLM scoring to use content-quality.js** - This is the root cause
2. **Add show title validation** - Catches content about wrong shows
3. **Post-garbage score invalidation** - Fixes existing bad data

### Medium Priority

4. **Multi-show detection** - Catches 404-style pages with multiple show snippets
5. **Pre-scoring validation pipeline** - Comprehensive check before scoring

### Lower Priority

6. **Explicit score priority** - Refines scoring when explicit scores exist

---

## Testing Plan

1. **Unit tests for content-quality.js:**
   - Test NYSR 404 page pattern detection
   - Test multi-show detection
   - Test show title validation

2. **Integration test:**
   - Score a known garbage review, verify it's rejected
   - Score a review for Show A with text about Show B, verify warning

3. **Regression test:**
   - Re-run scoring on the 3 fixed NYSR reviews, verify they're rejected/scored correctly

---

## Files to Modify

| File | Change |
|------|--------|
| `scripts/llm-scoring/index.ts` | Use content-quality.js in getScorableText() |
| `scripts/lib/content-quality.js` | Add validateShowMentioned(), detectMultiShowContent() |
| `scripts/fix-garbage-scores.js` | NEW: Invalidate LLM scores on garbage reviews |
| `.github/workflows/llm-ensemble-score.yml` | Add pre-scoring validation step |

---

## Monitoring

Add these metrics to the scoring run summary:

```json
{
  "skippedGarbage": 5,
  "skippedNoShowMention": 2,
  "skippedMultiShow": 1,
  "usedExcerptsInsteadOfGarbage": 3,
  "explicitScoreOverrides": 4
}
```

This helps track how often these safeguards trigger.
