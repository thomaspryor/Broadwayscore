---
name: feedback_data_propagation_is_automatic_verify_list_pages
description: "shows.json edits propagate automatically on every deploy (prebuild.sh regenerates all aggregates); the slim cache already invalidates on category/genre. List-page staleness is deploy-lag, not a cache bug — verify /west-end + /off-west-end, not just show pages."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2350e148-6bc6-4805-9a87-dddfea2ac7b9
---

When a `shows.json` edit (category, genre, dates, etc.) seems not to show up on the live site, it is almost always **deploy-lag, not a stuck cache**. The propagation path is fully automatic:

- **Every `next build` runs `scripts/prebuild.sh`** (the `prebuild` npm hook), which regenerates ALL derived aggregates from the current `shows.json`: `generate-mobile-show-details.js` (slim `public/data/shows/{id}.json`), `generate-search-shows.js` (search dropdown), `generate-mobile-data.js` (index), plus homepage archive, etc. So a deploy ALWAYS rebuilds aggregates against whatever `shows.json` it checked out.
- **List pages** (`/west-end`, `/off-west-end`, `/broadway`, browse) read `shows.json` directly via `getAllShows()` in `src/lib/data-core.ts` — they reflect the build's data snapshot immediately, no separate cache.
- **The slim-file cache already invalidates on any show-field change.** `computePerShowHash()` in `generate-mobile-show-details.js` hashes `JSON.stringify(show)` — the whole entry — so `category`/`genre`/date changes bust that show's cache. (Handoff #5.2 worried this needed a fix; it does not.)

**Why a data edit can look stale for a few minutes:** the deploy cron (every 5 min) may build against the data-repo commit *before* your push landed on `origin/main`. The next deploy builds against fresh data and the list pages correct themselves. It self-heals.

**Verification lesson (the real gotcha):** after pushing a `shows.json` change, check the **LIST page** (`/west-end`, `/off-west-end`), not just the show detail page — they have independent render paths (list = `shows.json` snapshot; detail = slim file) and can briefly disagree during a deploy race. `node scripts/check-prod-deploy.js HEAD` only proves the WEB commit is live; a **data-only push does not change the web commit**, so it lands on the next deploy cron — don't expect check-prod-deploy to confirm data freshness.

**To regenerate aggregates locally** after a data edit: `bash scripts/prebuild.sh` (or just `npm run build`). There is no separate "regenerate aggregates" command because prebuild already is it.

Related: [[feedback_dual_repo_data_files]] (shows.json lives in the private data repo), [[feedback_e2e_runs_against_production]] (UI fixes stay red until the deploy lands).
