---
name: strong-anywhere-scan-must-be-gated
description: Extending a position-limited content-quality detector to whole-body (like the 404 STRONG_ERROR fix) is only FP-safe for phrases that never appear in real review footers; cookie/legal/paywall phrases need a no-review + non-trailing gate
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0431663c-9062-4a22-8a36-eb17bf454469
---

When a content-quality detector misses a "buried" marker (the distinctive phrase pushed past its first-N-char window by a long nav-chrome prefix), the instinct is to copy the 404 fix: add a `STRONG_*_PATTERNS` array + `detect*Anywhere` whole-body scan. **This is only safe for the 404 case.**

The 404 strong patterns ("page not found", "404 error", "the page you're looking for") are FP-safe over the whole body because they NEVER appear in a real review's prose OR trailing footer. Cookie/legal/paywall phrases are different: "Continue reading with a subscription" (WSJ), "Terms of Use | Privacy Policy" (HollywoodReporter), "Thanks for subscribing!" (TimeOut), GDPR/cookie footers (The Stage) appear as legit **trailing footer chrome on hundreds of currently-scored real reviews**. A naive position-independent scan of those would flag and drop all of them — exactly what the existing trailing/leading-junk carve-outs correctly prevent.

**The safe pattern (shipped 2026-06-05, `content-quality.js` `STRONG_CHROME_DUMP_PATTERNS` + `detectStrongChromeDumpAnywhere`):** scan the whole body for the unambiguous full-page chrome phrases, but gate the flag on BOTH (a) `!hasSubstantialReviewContent` (no review prose to protect) AND (b) the marker is NOT in trailing junk (`!_isPatternInTrailingJunk`). That catches genuine chrome-dump pages while leaving every real review untouched.

**Why:** the FP risk for these phrases is structural, not a corpus accident — real scraped reviews routinely carry subscription/legal/newsletter footers. The gate is what makes the whole-body scan correct.

**How to apply:**
- Before adding strong-anywhere patterns, run the empirical test: among currently-PASSING substantial reviews, how many match the candidate? If >0 and they're real reviews (high theater-keyword count, marker at pos>0.6), the phrase is NOT FP-safe for an ungated scan.
- Always run a full-corpus parity diff (old vs new `isGarbageContent`) and require 0 valid→garbage flips on real reviews before shipping. See [[feedback_refactor_parity_test]].
- Register any new pattern family in `scripts/audit-regex-patterns.js` `PATTERN_FAMILIES` (CI gate; orphan-family-free convention). Gated patterns have ~0 raw hits so no allowlist entry is needed.
- Add the test to `tests/unit/` AND register it in `test.yml`'s `node --test` list or `audit-orphan-tests.js` fails CI. See [[feedback_content_quality_regex_fps]].

The card hypothesis that "more contamination is likely hiding" was empirically FALSE for the current corpus (0 flips across 30,882 files; 2/18,413 already flagged). The fix is a preventive guard against future buried chrome-dumps, not a cleanup.
