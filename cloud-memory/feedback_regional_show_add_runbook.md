---
name: regional-show-add-runbook
description: "Repeatable data-only steps to add a non-NYC US \"regional\" show (e.g. A.R.T.) now that the category mechanism is built"
metadata: 
  node_type: memory
  type: project
  originSessionId: da874463-1429-49e2-ac1c-6541d787ab25
---

The `regional` show category shipped 2026-06-22 (first show: black-swan-regional-2026, A.R.T.). The CODE is done — adding more regional shows is **data-only, no code changes**, flag already on (`NEXT_PUBLIC_FEATURES` includes `regional`).

**Per-show steps (all data; ~20-30 min/show):**
1. **Pick** a buzzy non-NYC US show that has a **published review roundup** (that's the signal it has enough critic coverage). Broadway-feeder venues: A.R.T. (Cambridge), Goodman (Chicago), Old Globe + La Jolla Playhouse (San Diego), Berkeley Rep, Arena Stage (DC), 5th Ave (Seattle), Paper Mill (NJ).
2. **shows.json** (private repo `~/broadway-scorecard-data`, **commit IMMEDIATELY** — CI clobbers uncommitted; happened with Black Swan): id/slug `<slug>-regional-<year>` (slug MUST contain `-regional` for `useCurrentMarket` detection), `category:'regional'`, `market:'regional'`, venue "Theater, City, ST", type, dates, creativeTeam, cast. Write via `JSON.stringify(data,null,2)+'\n'` (canonical, minimal diff). `node scripts/validate-data.js` must pass (regional→market regional is valid).
3. **Outlets**: add new regional outlets to `outlet-registry.json` (dual-repo) with `domain` + `tier` (regional critics mostly T3; majors like Chicago Tribune T2). Verify `resolveCanonicalOutletId({outletArg,url})` resolves by domain.
4. **Reviews**: fetch BOTH Playbill ("The Verdict") AND BroadwayWorld ("Review Roundup") via `fetchPage()` — **each lists a different/partial set** (Playbill gave 4 for Black Swan, BWW had 5, only 1 overlap). Dedupe across both, fetch each full text, ingest as `manualEntry:true` into reviews.json with an honest `assignedScore` per review (INCLUDE pans — a Boston Globe pan dropped Black Swan 86→78). `manualEntry` reviews survive CI rebuild (rebuild-all-reviews.js:4144 preservation block) — no review-text source files needed. Min 3 reviews to display a score.
5. **Audience**: `node -r dotenv/config scripts/scrape-reddit-sentiment.js --show=<id>` + `scripts/scrape-mezzanine-audience.js --show=<id>` (both now regional-aware). **Mezzanine is GLOBAL** — it has regional productions (Black Swan A.R.T.: 90 ratings, 4.3★); don't assume NYC-only. Show Score + Theatr are NYC/London-only (skip). Need ≥15 classified reviews to display (MIN_AUDIENCE_REVIEWS).
6. **Image**: fetch the theater's show-page `og:image` (key art) → `poster.webp` + `thumbnail.webp` (sharp, 2:3 cover, position:'attention'); a production photo → `hero.webp` (landscape). Save to `public/images/shows/<id>/`; add `images` field to shows.json. (`fetch-show-images-auto.js` won't find regional — it's TodayTix-only.)
7. **Verify**: dev server `NEXT_PUBLIC_FEATURES=regional npx next dev -p 3099`; the worktree needs real (non-symlink) local copies of shows.json/reviews.json/audience-buzz.json so edits render + survive CI clobber during QA. Confirm score + audience chip + REGIONAL badge/pill/trust line.
8. **Ship**: push the private data repo with a **commit-immediately + retry-on-reject loop** (`git fetch; git reset --hard origin/main; reapply idempotent deltas; commit; push`). No web push (no code). Cron deploys within ~5-10 min; verify live URL is 200.

**T3-only shows need minReviews+2 (=5 for regional)** — `generate-mobile-show-details.js` adds `T3_ONLY_EXTRA=2` when a show has zero T1/T2 reviews, so 4 all-T3 reviews render a breakdown but NO score. Fix by ingesting a 5th review or re-tiering the market's major metro daily to T2 in outlet-registry (Chicago Tribune precedent; The Tennessean added T2 2026-07-15 for the Dolly Nashville tryout — its review was syndication-misfiled under knox-news T3).

**Score-display thresholds for `regional` live in 3 places** (all set to min-3, matching off-broadway): `src/config/score-buckets.ts`, `src/lib/market-utils.ts` (ScoreBadge), `scripts/generate-mobile-show-details.js`. If adding another sub-market later, update all three.

**Fail-closed**: regional uses `market:'regional'` (NOT 'broadway') so `.market !== 'broadway'` gates (broadcast sender, recoupment/closure pollers) exclude it. `featureFlags.regional` gates detail-page static params + sitemap + search index. `/partners` was a leak (now gated). See [[feedback_dual_repo_data_files.md]], [[feedback_data_repos_clobber_uncommitted.md]].
