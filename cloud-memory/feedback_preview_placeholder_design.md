---
name: preview_placeholder_design
description: Design decisions and gotchas for the isPreviewPlaceholder flag system (Structural #3)
type: feedback
originSessionId: 63fd5bcb-b1e3-4543-80dd-1ded76b5e2f1
archived: true
---
Backfill and gather-reviews intentionally skip files WITH fullText — preview full-text articles (Deadline first-look, Variety preview) are not stubs. They get post-opening metadata merged in (star ratings, excerpts) rather than replaced wholesale. This is correct.

**Why:** Only stubs (fullText=null) are problematic for opening-night dedup. Files with real content just need metadata enriched.

**How to apply:** When debugging "why didn't the placeholder get replaced?", check if the file has fullText. If so, it was never marked placeholder — normal merge path applies.

---

cleanup-duplicate-reviews.js, cleanup-phantom-outlets.js, cleanup-review-sources.js call mergeReviews without fromPostOpening. If they run on a placeholder file before opening night, the isPreviewPlaceholder flag survives the merge. This is acceptable — the opening-night-poller will still replace it correctly (it passes fromPostOpening:true).

**Why:** Cleanup scripts don't have a post-opening signal, so wiring fromPostOpening into them would require significant refactoring with no clear benefit.

**How to apply:** Don't add fromPostOpening to cleanup scripts. Accept that placeholder-flagged merged files stay replaceable until the poller runs.

---

hamlet-off-broadway-2026 looks like the right integration test target (10 pre-opening stubs) but most of its placeholder files already had wrongProduction:true (from the 2015 Sarsgaard run). wrongProduction files were ALREADY excluded from getKnownUrls before this feature. Real test case: cyrano-de-bergerac-west-end-2026 (placeholder stubs without wrongProduction).

**How to apply:** For future integration tests of the placeholder system, use a show where stubs DON'T have wrongProduction set — e.g. cyrano WE 2026.
