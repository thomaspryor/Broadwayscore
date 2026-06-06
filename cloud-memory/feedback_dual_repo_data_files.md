---
name: Dual-repo core data gotcha (shows.json, reviews.json)
description: "shows.json/reviews.json authoritative in private repo; public edits overwritten."
type: feedback
originSessionId: afca0caa-8249-42ba-9d0f-90ac617cc92a
---
**data/shows.json, data/reviews.json, and other core data files are authoritative in the private `broadway-scorecard-data` repo — NOT the public `Broadwayscore` repo.** Edits to the public copy get silently overwritten at deploy time.

**Why:** The Vercel deploy workflow has a "Checkout core data" step (`.github/actions/checkout-core-data/action.yml`) that clones `broadway-scorecard-data` into `/tmp/core-data-checkout` and copies ALL `*.json` files on top of `data/`. So whatever is in the public repo's `data/shows.json` is replaced with the private repo's version before the Next.js build runs. Found in WE pre-Reddit-launch audit (2026-04-11): I pushed R&J synopsis + Royal Court OWE recategorization to `data/shows.json` in the public repo, the deploy succeeded, but the changes were silently reverted because the private repo still had the stale content.

**How to apply:**
- `data/reviews.json` is a symlink to `~/broadway-scorecard-data/reviews.json` (already gitignored + untracked)
- `data/shows.json` is now a symlink to `~/broadway-scorecard-data/shows.json` (converted 2026-04-11, see commit on both repos)
- When editing either file locally via Edit/Write/node scripts, **the change writes through the symlink to the private repo** — you still need to `git add/commit/push` in `/Users/tompryor/broadway-scorecard-data/` to make it permanent
- All the other core data files (awards, critic-registry, outlet-registry, etc.) live in the private repo only and are pulled into `data/` by `setup-local-data.sh`. Edits to those files would also need to be pushed to private.
- **Never commit `data/shows.json` or `data/reviews.json` to the public `Broadwayscore` repo** — they are gitignored (lines 119, 120 of `.gitignore`). If you see them staged, something is wrong.

**The multi-repo regression trap:** Even pushing to the private repo isn't enough protection. CI workflows that run on the public repo (`gather-reviews`, `rebuild-reviews`, `enrich-*`, `auto-maintain`) modify `data/shows.json` in the public workspace and then call `push-core-data` action to sync back to private. If ONE of those workflows runs with stale input (e.g., a merge conflict resolved "take theirs"), it silently reverts your fix on BOTH repos.

**Worked example (2026-04-11):** I recategorized 10 Royal Court shows to OWE in session commit `d77c6d4be4`, pushed to both public and private. A few hours later, public commit `0ab0afb016 "Resolve merge conflict on validation-baseline.json (take theirs)"` ran on the public repo — its merge conflict resolution "took theirs" on `data/shows.json` as a side effect, reverting all 10 Royal Court categories. That commit then propagated to the private repo via `push-core-data`. I had to re-apply the fix directly in the private repo (commit `f7e0064`) and verify the public repo never sees `data/shows.json` again.

**Future session checklist before editing core data:**
1. `git -C /Users/tompryor/broadway-scorecard-data log -5 --oneline` — check the private repo isn't mid-rebuild
2. Read `data/shows.json` via the symlink to get the freshest state
3. Edit + `git -C /Users/tompryor/broadway-scorecard-data commit + push`
4. After session, verify fix survived by reading live broadwayscorecard.com data URL with a cache-bust query param
5. If a CI workflow ran during the session, re-check — it may have clobbered your fix. Re-apply if so.
