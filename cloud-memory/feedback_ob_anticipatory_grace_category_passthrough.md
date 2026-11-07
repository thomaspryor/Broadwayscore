---
name: ob-anticipatory-grace-category-passthrough
description: Off-Broadway 14-day anticipatory grace requires show.category passed to isAnticipatoryPreviewPost; missing category silently falls back to 2-day Broadway default
metadata:
  type: feedback
---

isAnticipatoryPreviewPost (scripts/lib/content-filters.js) selects grace days by:
1. opts.graceDays explicit override (tests)
2. preview-heavy outlet → 0d
3. off-broadway/off-west-end → 14d
4. Broadway/West-End default → 2d

**Why:** OB shows have 14-21 day preview windows and no embargo cadence. Critics legitimately review during previews — the 2-day Broadway default silently flagged ~103 OB review files as wrongProduction=anticipatory_pre_opening_post.

**How to apply:** Every ingest path that calls isAnticipatoryPreviewPost must pass `opts.category` (read from shows.json for the show being processed). Missing category falls through to Broadway's 2-day default — silent regression.

Existing callers (must include category):
- scripts/collect-review-texts.js:4244 ✓ passes showCategory
- (any future ingest paths)

Tests: tests/unit/anticipatory-preview-gate.test.mjs has 8 cases covering OB-grace + precedence + Broadway-no-leak.

Related: [[feedback_aggregator_pages_post_opening]] — aggregator review pages don't exist pre-opening regardless of grace.
