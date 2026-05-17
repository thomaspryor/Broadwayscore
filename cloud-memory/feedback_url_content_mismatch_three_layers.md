---
name: url_content_mismatch needs three coordinated fixes
description: NY Sun Joe Turner postmortem — when fetcher rejects valid pages as url_content_mismatch, the fix usually requires changes in BOTH article extractors (regex AND in-browser DOM) AND the validator. Fixing only one keeps it broken.
type: feedback
originSessionId: 5f231df6-b21c-446f-998f-c89cf92a7824
archived: true
---
When you see `failureReason: url_content_mismatch` and the page actually contains the review (verified by curl), the bug is likely in 3 coordinated layers, not 1:

1. **`scripts/lib/article-extractor.js`** — regex-based extractor used by ScrapingBee/BrightData paths. Generic `<article>` regex with `.match()` returns the FIRST match, which on Next.js/SPA sites is often a sidebar teaser card (NY Sun has 8 of them with class `group/article-teaser`).

2. **`scripts/collect-review-texts.js` line ~3396** (`async function extractArticleText(page)`) — IN-BROWSER DOM evaluator used by Playwright. Uses `document.querySelector('article')` which has the same first-match bug. The selector list also tries `<main>` last, so even single-article sites can be misled if `<article>` exists at all.

3. **`scripts/lib/content-quality.js` `validateContentMentionsShow`** — the URL-vs-content sanity guard. Two latent bugs:
   - Curly-quote tokens never match straight-quote text and vice versa. shows.json uses ASCII apostrophe; outlets use U+2019.
   - For possessive titles ("Joe Turner's Come and Gone", "Mike Birbiglia's X"), body text uses the SHORT form ("Joe Turner") and only the headline uses the full title. The full-title token only counts 1 hit and fails the 3-mention threshold.

**Why:** Joe Turner 2026-04-26. Initial regex extractor fix made playwright text "look" right, but the in-browser DOM extractor still grabbed sidebar teasers. Fixed THAT, validator still failed because of curly quotes. Fixed THAT, still failed because possessive title only appears 1× in body. Three rounds of "the fix didn't work" before all three layers were aligned.

**How to apply:**
- When url_content_mismatch is reported with `mentionCount` >0 (not 0), suspect a TOKEN mismatch (curly quotes / possessive form), not extraction.
- When `mentionCount` is 0 AND text length is normal (>1500 chars), suspect EXTRACTION (wrong selector picked teaser/related content).
- Always test the live `extractArticleText` (DOM eval) separately from the regex extractor — they have independent bugs.
- After ANY scraper or validator fix, re-fetch the failing review with `SHOW_FILTER=show-id RETRY_FAILED=true MAX_REVIEWS=N node scripts/collect-review-texts.js` and read the actual log; don't trust `node --check` or unit tests.
- **State files multiply**: Mandell hit failureCount=5 AND was in `state.processed` AND `state.failed` AND `failed-fetches.json`. Required clearing 4 separate state files. Worktree's `data/collection-state/progress.json` is a SEPARATE FILE from main repo's — clearing one doesn't clear the other.
- **Single-word possessive trap**: 47 shows in shows.json have single-word possessive titles ("Hell's Kitchen", "It's Only a Play", "Marvin's Room"). The original possessive-prefix logic required `/\s/.test(prefix)` which silently filtered all of them out. Fixed in `f1c80a4c66` — possessive token regex now matches both multi-word and single-word forms.
- **WordPress + Jetpack chrome**: `entry-content` containers on Jetpack-enabled WP sites have `.sharedaddy`, `.jp-relatedposts`, `#jp-post-flair` chrome INJECTED INSIDE the article body. The ensemble scoreability LLM correctly rejects these as "not_a_review" because chrome dilutes review prose. Fix in BOTH the regex extractor (truncate at first chrome marker) AND the DOM extractor (`closest()` filter on `<p>` tags).
- **Parallel session revert risk**: This fix was reverted ONCE by a parallel session's "merge: keyPhrases tier-change clear" (commit 9c19b5afda) and had to be re-restored. Added a `⚠️ DO NOT REVERT` comment in `scripts/lib/article-extractor.js` next to the chrome-stop pattern. See `feedback_parallel_worktree_race.md`.
- Tests live in `tests/unit/article-extractor-multi-article.test.mjs` (9 cases across 3 describe blocks).
- Code commits: Broadwayscore `863ad705b7` + `5794fb0da3` + `0c10b72fb6` + `f1c80a4c66` + `a5339d40d2` + `f0a924250b` (2026-04-26 / 2026-04-27).
