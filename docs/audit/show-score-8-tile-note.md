# Show-Score "extracted exactly 8 of N" — reproduction and root cause (BRO-4204 S7-T9)

Date: 2026-09-28. Show: `bug-2026` (Broadway, 19 critic reviews on Show Score).
URL from `data/show-score-urls.json`: `https://www.show-score.com/broadway-shows/bug-broadway`.

## Symptom

`data/audit/show-score-extraction-gaps.json` (written by
`scripts/extract-show-score-reviews.js` from the archived HTML) had 361 rows;
**357 of them read `extracted: 8`**, 24 of those 2026 shows — bug-2026 was
`expected 19, extracted 8, severity error`. The archive file
`aggregator-archive/show-score/bug-2026.html` (fetched 2026-03-19) contains
`Critic Reviews (19)`, `data-total-count="19"` and exactly 8
`.review-tile-v2.-critic` tiles.

## Reproduction (read-only)

1. **Through the real `fetchPage()`** (`scripts/lib/scraper.js`, Playwright
   tier — no scraper API keys in this sandbox; the proxy CA was added to the
   browser NSS store so TLS verification stayed on):

   ```
   fetchPage source: playwright  bytes: 238275
   critic tiles in HTML: 8 | distinct critic_review ids: 8 | heading says: 19
   pagination: {"nextPagePath":"/shows/bug-broadway/paginate_critic_reviews","totalCount":19}
   extractShowScoreReviews returned: 8 reviews
     nytimes, nytg, timeout, vulture, wsj, variety, washpost, ew
   ```
   The initial render — server-side or headless-browser — carries **8 tiles
   of 19**. `extractShowScoreReviews()` (gather-reviews.js) returns exactly
   those 8, which is correct for that HTML: the other 11 are not in it.

2. **Where tiles 9..N live.** `GET /shows/bug-broadway/paginate_critic_reviews?page=2`
   → JSON `{"html": …}` with 8 tiles; `page=3` → 3 tiles; `page=4` → `{"html":" "}`.
   Plain `https.get` (no UA) and `fetch()` both get it (HTTP 200,
   `application/json`), so `gather-reviews.js fetchShowScorePaginatedReviews`
   (:704) and `show-score-discover.js fetchAllShowScoreReviewUrls` (:122)
   *do* reach 19 when they run — the review-text corpus for bug-2026 has 18
   files carrying `show-score-playwright` in `sources`. Neither of those is
   the path that produced the archive.

3. **What the archive path does** (`scripts/fetch-aggregator-pages.ts
   fetchShowScore`, the loop at the former :279-301): after landing, it set
   `el.scrollLeft = el.scrollWidth` on `.js-show-page-v2__critic-reviews`,
   waited 800 ms, and broke out after two iterations with no new tile. A
   Playwright probe against the live page (`ss-carousel-probe.js`, scratch)
   with a request listener on `paginate_critic_reviews`:

   ```
   initial tiles: 8  header: 19
   root scroll iter 0..2:          tiles=8   paginate requests so far: 0
   descendant scroll iter 0..2:    tiles=8   paginate requests so far: 0
   next-arrow click iter 3:        tiles=16  paginate requests so far: 1   ← page=2
   direct pagination append:       { total: 19, added: 11 }                ← pages 2..4
   ```
   Scrolling the container — root or any scrollable descendant — never
   issues a pagination request. Show Score loads the next 8 tiles **only on a
   click of the carousel's next arrow** (each click = one `?page=N` fetch),
   so the scroll loop's `tilesAfter === tilesBefore` fired twice and it
   exited with the 8 server-rendered tiles. `page.content()` then archived
   those 8, and `extract-show-score-reviews.js` faithfully reported 8/19.

**Exact code path that stops early:** `scripts/fetch-aggregator-pages.ts`
→ `fetchShowScore()` → the carousel "scroll to the right until the count
stops growing" loop → `stableIterations >= 2` → `break` with 8 tiles →
`saveHtml()` → `extract-show-score-reviews.js` → `extracted: 8`.

Verdict: **real defect** (the scroll is not what triggers Show Score's lazy
load), so it was fixed rather than only recorded.

## Fix

`fetchShowScore()` now reads `data-next-page-path` / `data-total-count`
with the shared `parseShowScorePagination()` and, for the pages
`showScorePaginationPages(N)` returns (2..⌈N/8⌉+1, the same rule the two
paginating consumers use), calls the site's own endpoint **from the page
context** (`page.evaluate` + same-origin `fetch`) and appends each returned
tile wrapper into `.js-scrollable-block__elements` before `page.content()`.
Dedup by `critic_review_N` id; stop at the first empty fragment or a page
that adds nothing. No scroll, no timing dependence.

Real-data run (`npx tsx scripts/fetch-aggregator-pages.ts --aggregator
show-score --shows bug-2026,every-brilliant-thing-2026,hamlet-2026 --force`,
worktree archive, tracked outputs reverted afterwards):

```
[show-score] bug-2026: +11 paginated critic tile(s) over 3 page(s) (heading 19, data-total-count 19)
[show-score] every-brilliant-thing-2026: +11 paginated critic tile(s) over 3 page(s) (heading 19, data-total-count 19)
extract-show-score-reviews.js: bug-2026 19/19 critic reviews extracted; every-brilliant-thing-2026 19/19
show-score/hamlet-2026: Show not found in shows.json   (stale id — see below)
```
Archived `bug-2026.html`: 19 `.review-tile-v2.-critic` tiles, 19 distinct
`critic_review_` ids (each id is rendered twice per tile, hence the old
"captured 38/19" log — the count is now distinct ids).

Unit test: `tests/unit/show-score-archive-pagination.test.mjs` (real
`showScorePaginationPages` / `parseShowScorePagination` /
`fetchAllShowScoreReviewUrls` + wiring assertions on the TS file).

## Side findings (not changed here)

- `scripts/re-extract-aggregator-reviews.js:290-291` still matches
  `data-next-page-path="…"` / `data-total-count="…"` with double quotes only.
  That works on *archived* HTML (Playwright's `page.content()` serialises
  attributes with double quotes) but would match nothing on the live,
  single-quoted markup. Harmless today because it only reads the archive.
- `hamlet-2026` is no longer in `shows.json` (the Hamlet rows are
  `hamlet-off-broadway-2026`, `hamlet-by-william-shakespeare-off-broadway-2026`,
  `hamlet-the-furies-off-broadway-2026`), yet `data/dtli-slug-map.json` still
  maps it — to `hamlet-broadway`, DTLI's **2008** page. The S7-T9 year rule
  unmaps it under `--force` (dry-run output in the task hand-back).
- The 357 stale `extracted: 8` archives refresh on the next
  `fetch-aggregator-pages.yml` / `refresh-show-score-opening-night.yml` run;
  no data was touched by this task.
