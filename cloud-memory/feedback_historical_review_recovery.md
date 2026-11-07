---
name: Historical review recovery — what gather-reviews misses
description: Three blind spots that hide real reviews from gather-reviews on pre-2015 shows; manual recovery patterns
type: feedback
originSessionId: efa2a933-8f2d-45b1-97e1-a6a40e255001
archived: true
---
# Historical review recovery

When a pre-2015 show has suspiciously few reviews (<8 vs era median 10–25), don't assume coverage was thin. Three blind spots in gather-reviews hide real reviews:

## 1. Variety canonical-redirects break url_mismatch guard
- Real example: Joe Turner's Come and Gone 2009. Variety review lives at `/2009/film/awards/joe-turner-s-come-and-gone-1200474530/`. SERP/guess targets the expected `/2009/legit/reviews/...` pattern. Variety canonical-redirects to the awards path with a different ID. `scripts/lib/scraper.js:668` rejects this as `url_mismatch`.
- **Why:** The guard correctly protects against soft-404 → homepage, but here it blocks a legitimate canonical move.
- **How to apply:** When checking historical Variety, follow `Location:` redirects manually with `curl -sIL`. If canonical includes the show slug AND same domain, the page is real. Add to review-texts directly bypassing gather-reviews.

## 2. SERP indexing degrades to ~1/44 hits for pre-2010 shows
- Google deindexes very old archives, and date-filtering makes it worse. Joe Turner 2009 SERP returned 1 hit out of 44 queries during gather.
- **How to apply:** For pre-2015 historical shows, don't trust SERP. Go directly to: outlet archive search APIs (NYT, WaPo), Wayback Machine `/web/2009*/` (with full timestamp, not glob), Wikipedia "References" section, complete-review.com.

## 3. score-reviews-llm.js skips files where assignedScore is undefined
- Bug at `scripts/score-reviews-llm.js:140`: `if (review.assignedScore !== null) skip` — `undefined !== null` is true, so any newly-created review file (which has no `assignedScore` key) gets skipped as "already scored."
- **Workaround:** When manually creating a review file for one-off recovery, include `"assignedScore": null` explicitly. Then run `node scripts/score-reviews-llm.js --show=<id>`.
- **Real fix:** Change the guard to `review.assignedScore != null` (loose equality) or `typeof review.assignedScore === 'number'`. Worktree-required code change.

## Manual-recovery flow that worked (Joe Turner 2009 Variety)
1. Discover real URL via canonical mismatch error message (scraper logs `actual: <url>` on rejection).
2. `fetchPage(url)` returns `{ content, format, source }` — the field is `content`, NOT `html`. Multiple session scripts have wasted minutes on this.
3. Extract paragraphs from article body (Variety wraps each in `<p>`).
4. Write review-text JSON with required fields: `showId, outletId, outlet, criticName, url, publishDate, fullText, isFullReview, source, contentTier, assignedScore: null`.
5. `node scripts/score-reviews-llm.js --show=<id> --limit=2` (single-model Claude scorer, ~$0.005 per review).
6. `node scripts/rebuild-all-reviews.js --shows=<id>` to fold into reviews.json.
