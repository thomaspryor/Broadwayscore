---
name: previews-open-flip-needs-review-signal
description: "previews→open flip was gated on openingDate; null openingDate + no ShowScore URL stranded opened shows, suppressing their score"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 39b876e2-d30b-4230-b2f4-407c181d9a11
---

**A show stuck in `status: previews` suppresses its CriticScore no matter how many reviews it has** — the site's `showTBD` gate (`src/app/show/[slug]/page.tsx`) short-circuits on `status === 'previews' || 'upcoming'` before the review-count check. So a stale previews flag, not the score bar or the dates, is the usual cause of "show has reviews but no score."

**Root cause of the staleness (2026-06, hit rodeo / the-last-man / small):** `scripts/update-show-status.js` only flipped previews→open when `openingDate` was set (Check 2: `status==='previews' && openingDate && isDateReached(openingDate)`) or when ShowScore reported "open" (needs a ShowScore URL mapping). A show with `openingDate: null` and no ShowScore URL — common for Off-Broadway / Off-West-End — had no path to flip and sat in previews forever, even after a full slate of scored reviews landed.

**Why:** the orchestrator/date-based flip assumed openingDate is always populated. It often isn't for OB/OWE. The reviews themselves are the missing ground-truth signal: critics review on/after press night, not during previews.

**The fix (Check 2d, `scripts/lib/opening-signal.js` + colocated test):** when a previews/upcoming show has `>=` the category's score-display threshold of scored reviews (`reviews.json` is the clean displayed set — count per `showId` == site's review count), flip to `open` and backfill `openingDate` from the modal review date (press night). Thresholds mirror `MIN_REVIEWS_FOR_SCORE*` in `src/config/score-buckets.ts` (broadway 5, off-broadway 3, west-end 5, off-west-end 3). Runs in the daily Update Shows job — backstop, not the primary opening-night path.

**How to apply:**
- Diagnosing "show not scored" — check `status` FIRST (`previews`/`upcoming` → that's it), not the review count or dates. Fix by flipping status + setting openingDate in the **private** `broadway-scorecard-data` repo (see [[feedback_dual_repo_data_files]]), then ship via `gh workflow run "Rebuild Reviews (Fast)"` (auto-triggers deploy via workflow_run).
- Sweep the whole class: `findStuckPreviews(shows, countByShow(reviews))` from `scripts/lib/opening-signal.js`.
- Catch-up flips are tagged `reviewDriven` and excluded from `opened_count`/`opened_slugs` so they DON'T trigger the opening-night poller/broadcast for a show that opened weeks ago (see [[email-broadcast-rules]]).
- New source files touched by a gated test MUST be added to `test.yml` `on.push.paths` or the push runs zero CI (see [[feedback_test_yml_push_path_allowlist]]).
