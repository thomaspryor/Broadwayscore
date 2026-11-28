---
name: Test every title length, not just the target case
description: Regression tests for title-match fallbacks must cover titles shorter than the pre-filter's min-word-length, or fail-open bugs slip past
type: feedback
originSessionId: a888b2ec-9af0-421d-8ea2-44d03167b5f1
archived: true
---
When I added the comma-subtitle short-title fallback to `urlLooksLikeReview` and `verifyTbPage` (2026-04-24 Beaches fix), my regression tests covered "Beaches, A New Musical" (7-char short) and "Becky Shaw" (no comma). All passed. Ship-check caught a P0 I missed: `shortTitleCandidate('Oh, Mary!')` returns `"Oh"` (2 chars), and:

- `urlLooksLikeReview` filters titleWords by `length > 2`, leaving `[]` → `titleWords.length === 0 → return true` fail-open. Any non-reject URL accepted.
- `verifyTbPage` uses raw `.includes(normVariant)` — 2-char "oh" substring-matches "Wholesome", "Mother", "though" in any TB page.

Both affected open shows (oh-mary-2024 + oh-mary-west-end-2025) that would have ingested arbitrary URLs on their next opening-night poller run.

**Why:** I tested against Beaches (my specific failure case) but didn't think about titles where the SHORT version lands below the pre-filter threshold. 2-char short titles are rare (Oh Mary is the only production example I know) but fatal.

**How to apply:** when adding any "short-form fallback" to a validator with a length/stopword pre-filter, verify:
1. Query real data for the extreme case — shortest short-title variant in the corpus.
2. Test at least ONE title where the short form lands BELOW the pre-filter threshold. Confirm it's rejected, not fail-opened.
3. Look at the fail-open semantics of the underlying function — if it returns `true` on empty-word-list (fail-open for "too short to validate"), the fallback MUST refuse to call it with shorter input than the primary.

**Rule added to ship-check lens:** the "statistical validity audit" phase should include a "length validity" check for any new fallback that produces a shorter representation of the input. Not every pre-filter gracefully handles short inputs.

**Files fixed:** `scripts/lib/review-guards.js`, `scripts/lib/tb-direct-url.js` (commit 1c377fed24). 4 regression tests added for "Oh, Mary!" in both validators.
