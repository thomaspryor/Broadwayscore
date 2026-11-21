---
name: BWW SERP returns tryout/pre-Broadway URLs
description: BWW publishes Review Roundups for Kennedy Center/world-premiere/tryout runs with identical title slugs; SERP returns them on opening night before the Broadway URL is indexed
type: feedback
originSessionId: 059fcd51-c17e-4a91-8e17-cc34bafd046b
archived: true
---
BWW publishes Review Roundups for Kennedy Center, tryout, pre-Broadway, and regional productions. On opening night, when Google hasn't yet indexed the Broadway roundup, SERP (`site:broadwayworld.com/article "Review Roundup" "Title" broadway 2026`) returns the earlier tryout URL instead.

**Why:** Incident 2026-04-20 Schmigadoon opening night. SERP returned `Review-Roundup-SCHMIGADOON-World-Premiere-at-the-Kennedy-Center-20250203` instead of the Broadway roundup. That page has 6 critics' blurbs for the 2025 Kennedy Center run — all got scored, and several show-level critic entries (NYT Margaret Lyons TV critic, Lucy Mangan Guardian TV critic, Washington Post, WSJ, Elliot Lanes BWW) entered `llm-scores/` before rebuild's wrongProduction guards excluded them from `reviews.json`. The rebuild backstop worked — zero reviews leaked — but the blurbs/fetches still burned credits and polluted llm-scores/_pending/.

**Fix applied (commit fc29a117f1):** Added `TRYOUT_URL_MARKERS` to `scripts/lib/bww-roundup-validator.js`:
- `world-premiere`, `kennedy-center`, `pre-broadway`, `out-of-town`, `tryout`
- Rejected at slug-check step before title/year match.

**How to apply:** When a new opening night creates BWW RR misses, check the SERP hit against TRYOUT_URL_MARKERS. If another marker pattern shows up (e.g. `trafalgar-theatre` for London tryouts, regional rep names), add to the list. The validator is shared between `gather-reviews.js` and `scrape-bww-roundups.js` so a single edit protects both paths.

**Still to do (systematic fix list):**
1. Add year-match to `validateBWWRoundupUrlMatchesShow` — reject URLs whose trailing `-YYYYMMDD` is >6 months before the show's openingDate. Would have caught the Kennedy Center case on year alone (2025 vs 2026).
2. When `bwwRoundupUrl` is unset in shows.json, opening-night-orchestrator should block the show from entering the poll list until the URL is manually supplied OR the show is >48h post-opening. Opens too much exposure to SERP misfires on launch day.
