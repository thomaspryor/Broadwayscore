---
name: Express pipeline end-to-end simulation pattern
description: How to safely simulate the Opening Night Express pipeline (gather→collect→score→rebuild→deploy) without touching live data, including the _devOnly + _skipCrossShowDupe pattern.
type: project
originSessionId: b2030ae3-d1b1-48aa-bbf4-b0db0216c7c2
archived: true
---
To prove the Express pipeline fires end-to-end (including the Vercel deploy), use a **clone-show pattern**, not a fictional show. Fictional shows skip gather/collect/score because no real URLs exist for them.

**Pattern:**
1. Clone a real opening show entry in `shows.json` (private repo) with a new `id` and add two flags:
   - `_devOnly: true` — hides the show from the live site (filtered in `data-core.ts:54`)
   - `_skipCrossShowDupe: true` — bypasses all three cross-show dedup guards so the test show can claim URLs/text already used by the source show
2. Trigger Express: `gh workflow run opening-night-express.yml -f show_id=<test-id> -f market=broadway`
3. Verify: gather finds URLs, collect fetches text, score runs, rebuild produces `before=0 → after=N`, deploy step shows "success" not "skipped"

**Why this works:** The Vercel deploy condition is `if: inputs.dry_run != true && steps.after.outputs.count > steps.before.outputs.count`. Cloned-show + bypass flags is the only way to get a meaningful before-vs-after delta without contaminating real shows.

**Why:** First validated 2026-04-19 with `proof-express-test-2026` (cloned from `proof-2026`). Express run `24636235616` produced before=0, after=6, deploy succeeded (`24636561862`). The 6 (vs 17 collected) revealed there were three dedup guards, not one — see [feedback_three_cross_show_dedup_guards.md](feedback_three_cross_show_dedup_guards.md).

**Caveat — re-run poisoning:** Once a test show's reviews land in `reviews.json` on main, future Express re-runs will show `before=N, after=N` (no delta) and skip the deploy. To re-prove the deploy fires, either:
- Bump the test show id (e.g., `proof-express-test-v2-2026`), or
- Manually delete the test show entries from `reviews.json` between runs (script: `node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('data/reviews.json','utf8'));d.reviews=d.reviews.filter(r=>r.showId!=='<id>');fs.writeFileSync('data/reviews.json',JSON.stringify(d,null,2));"`).

**How to apply:** Use whenever you need to confirm the full Express chain works end-to-end after pipeline changes. Don't skip the simulation; passing unit tests + lint + tsc proved insufficient for catching the dedup-guard count.

**Cleanup after simulation:**
- Remove test show entry from `shows.json` (private repo)
- Delete `review-texts/<test-show-id>/` directory (private repo)
- Rebuild + push to clear test reviews from `reviews.json`
- Keep `_devOnly` filter and `_skipCrossShowDupe` flag plumbing — those are permanent infrastructure
