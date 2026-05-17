---
name: scraper-table-assertions
description: HTML-table scrapers need structural assertions on column count + header labels — silent zero-row results from schema drift are how scrape-alltime broke for 2 months
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6f6a22bc-79fc-406e-b089-445b85593bc5
---

When parsing HTML tables in scrapers (`<table>` → cells[N] indexing), assume the source schema *will* change without warning and add structural assertions that fail loud.

**Why:** BroadwayWorld silently dropped their cumulative-grosses table from 7 columns to 5 in March 2026. `scripts/scrape-alltime.ts` had hardcoded `cells[6]` for performances + `cells.length < 6` length guard. Every row was rejected, but the script logged "Found 0 shows on page" — indistinguishable from "they removed the section." Apr 1 + May 1 monthly crons both returned 0 rows; only the `MIN_SHOWS_MAIN_PAGE=100` abort guard prevented null data from being written. The user noticed via a screenshot of Lost Boys' Box Office Scorecard showing only "This Week" with no "All Time" row — discovered 2 months after the silent failure began.

**How to apply:**
- Hardcoding `cells[N]` or `cells.length < N` makes you brittle to source-side column reorders/additions/removals. Add at least one of:
  1. Header-label assertion: read the `<th>` row, fail loud if expected labels are missing or reordered.
  2. First-row schema check: assert the first matching row has >= N cells AND specific format (e.g. `cells[1]` starts with `$`), otherwise `::error::` + `exit 1`.
- Per-URL minimum-row floors for multi-page crawls. The existing `MIN_SHOWS_MAIN_PAGE` only checks total across all pages — a single page returning 0 silently degrades coverage but passes.
- "0 rows scraped" must NEVER be treated as success. Emit GHA `::warning::` per empty page; abort the run if the main/primary page returns 0.
- For scrapers writing to a file that gets carried forward (e.g. `grosses.json`'s allTime field), silent zero-match means stale data persists indefinitely. Pair the assertion with a coverage-regression check: snapshot the set of slugs that matched last run; alert if any drop out without explanation.

**Files this rule applies to (audit pending — see Notion 363637c5-416f-81ff-b256-d6c0489a7475):**
- `scripts/scrape-grosses.ts` — weekly Broadway grosses (also from BWW)
- `scripts/scrape-playbill-verdict.js`
- `scripts/scrape-nyc-theatre-roundups.js`
- `scripts/scrape-bww-reviews.js`
- `scripts/scrape-alltime.ts` (fixed 2026-05-16 in commit 09c841f07c)

**Pattern reference:** see `scripts/scrape-alltime.ts:269` (`if (rows.length === 0)`) for per-page warning + `scripts/scrape-alltime.ts:435` for cross-page failure guard.

Related: [[scraper-architecture]] (fetchPage usage), [[fetchpage-gotchas]] (HTML-only, empty-200 cases).
