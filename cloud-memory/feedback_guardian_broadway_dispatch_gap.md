---
name: Guardian API must dispatch for Broadway, not just West End
description: opening-night-orchestrator only called fetch-guardian-reviews when market=west-end; Broadway Schmig 2026-04-20 got originalScore=null and LLM-scored 71 instead of API 3-star=65
type: feedback
originSessionId: 059fcd51-c17e-4a91-8e17-cc34bafd046b
archived: true
---
The `opening-night-orchestrator.yml` workflow had `fetch-guardian-reviews.yml` dispatched ONLY inside the West End branch (`if [ "$MARKET" = "west-end" ] || [ -z "$MARKET" ]`). Guardian's Jesse Hassenger is the US critic and covers Broadway openings — his starRating is ONLY in the Content API, not the HTML (see `feedback_guardian_api_not_html.md`). For Broadway openings, SERP-discovery captured the URL but left `originalScore: null`, so the LLM ensemble scored it at 71 instead of the true 3-star rating (65).

**Why:** Schmigadoon 2026-04-20 shipped with a Guardian score of 71 on the live site until manual intervention set `humanReviewScore=65` via Content API lookup. User's star rating from the night before was effectively lost — the pipeline had no way to fetch it.

**How to apply:**
- Guardian Content API must dispatch for BOTH markets on opening night, not just West End
- Fix: commit 887b58911f moved `dispatch "fetch-guardian-reviews"` out of the WE-only gate into a pre-market block
- For any future outlet with API-only ratings (stars-not-in-HTML), audit whether the orchestrator dispatches its API job for every market that outlet covers
- Check: does `fetch-guardian-reviews.yml` ACTUALLY process Broadway shows? Verify by running it manually with a Broadway show_id after this fix lands and inspecting the resulting file's `scoreSource`
- Pattern: any time a future outlet/API fetcher is added, ensure orchestrator dispatches it per the outlet's market coverage, not based on the show's market alone
