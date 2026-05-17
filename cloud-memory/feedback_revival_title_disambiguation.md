---
name: Revival-title shows need strict date match, not just title keyword
description: "isRevivalByCanonicalTitle needs ms pubDate + cast/crew surname match."
type: feedback
originSessionId: 49e1818d-b835-4c9b-b509-9aa0c044b012
archived: true
---
When classifying whether a review belongs to show X (e.g. during recovery, audit, or cross-show URL disambiguation), and show X has siblings sharing the same canonical title (`isRevivalByCanonicalTitle(showId, shows) === true`), do NOT trust a title-keyword match alone. Every production mentions its own title.

**The right signals for revival-title shows:**

1. **ms-granular pubDate window** — review was published inside `[firstPreview, closingDate+30d]` of this specific production, not just inside the calendar year. A review from the same year can be for a different production that closed months before the current one opened.

2. **Cast/crew surname match** — `buildShowKeywordSet(show)` in scripts/lib/review-guards.js includes top-5 cast surnames and top-3 director surnames. Surname match is much stronger than title-alone for disambiguation.

3. **URL year check** — if the URL contains `/YYYY/` and that year isn't in the run window, reject regardless of title match.

**Why:** During the 'Recover wrongProduction false positives' card, an initial classifier that accepted title-keyword + URL-slug + loose year-match included files like `a-christmas-carol-1991/theatrely--joey-sims.json` — Theatrely didn't exist in 1991, it's a modern review of a different Christmas Carol production misfiled to the 1991 show directory. Also `frozen-2004/newsday--barbara-schuler.json` is a Disney Frozen (2018 musical) review misfiled to Bryony Lavery's "Frozen" (2004 play). Both would have been auto-recovered by the loose classifier and re-introduced wrong-production contamination.

**How to apply:** In any classifier that decides "does this review belong to show X?", for shows where `isRevivalByCanonicalTitle` is true, REQUIRE:
- `dateInRunWindow(parseDateLoose(publishDate), showRunWindow(show))` where the run window uses ms granularity with a 21-day pre-preview grace and 30-day post-close grace, AND
- keyword hit is from `buildShowKeywordSet(show)` returning something OTHER than a bare title token (i.e. a cast/crew surname or venue word)

See `scripts/one-off/audit-wp-cv-valid.js` for the canonical classifier.
