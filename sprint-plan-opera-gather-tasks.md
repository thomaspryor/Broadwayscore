# Sprint Plan: Opera Auto-Discovery V2

## Overview

Extend the existing opera-discovery pipeline so future `type: opera` shows automatically capture reviews from the 11 outlets currently missed by `gather-reviews.yml`. Plan grew out of a manual ingest pass that found 17 reviews across 5 Met productions the cron pipeline never discovered. Reviewed 2026-05-17 via `/plan-review` (6 reviewers); P0 design issue cut, cost guards + concurrency safety added.

Source plan: `sprint-plan-opera-gather.md`
Notion: `363637c5-416f-81b3-9baa-cc318941cd3d`

## Sprint 0 findings (2026-05-17)

Audit run completed via `scripts/audit-opera-discovery-gap.js --all`. Output: `data/audit/opera-discovery-gap-2026-05.md`.

| bucket | count of 50 | % |
|---|---|---|
| discovery-miss | 33 | 66% |
| filter-miss | 0 | 0% |
| extraction-miss | 2 | 4% |
| hit | 15 | 30% |

**Sprint 2 proceeds as planned** — discovery-miss is the dominant bucket and `filterOperaUrls()` is not silently dropping known URLs.

Refined Sprint 2 outlet list (those actually surfacing discovery-misses, not already-registered):
- vulture (3 shows: Tristan, Innocence, Kavalier)
- newyorker (1: Tristan)
- nytimes (5: Tristan, Innocence, Kavalier, Onegin, Frida)
- washpost (1: Tristan)
- financialtimes (2: Tristan, Frida)
- times-uk (2: Tristan, Frida)
- artsdesk (1: Tristan)
- bwwopera (4: Innocence, Onegin, Traviata, Frida) — sibling file per Code Design review
- nystagereview (1: Innocence)

Out of Sprint 2 (per plan and audit):
- wsj (3: Tristan, Innocence, Kavalier) — deferred for subscriber-cookie refresh
- bachtrack — extraction-miss (paywall body) covered by existing data-debt card
- Operawire / NYCR / Classical Voice America — already-registered but missed Tristan + others due to descriptive-slug title-match bug. Filed as separate Notion card `363637c5-416f-8178-be37-e621a696b20e`.
- parterre-box / christopher-corwin La Traviata — 3rd-critic multi-critic SERP edge; address inside the existing parterre endpoint, not via new outlet.
- playbill roundup URLs (Innocence + Frida) — Sprint 3 handles roundup discovery as its own helper.

Sprint 2 task list still has S2-T1..S2-T10 as written — no tasks need to be cut or added based on audit. TheaterMania and Observer were already covered as **hits** by the existing pipeline; their plan-level Sprint 2 entries (S2-T7, S2-T8) are optional polish, not gap-closing.

**Recommended:** keep S2-T7 (TheaterMania) and S2-T8 (Observer) but de-prioritize them — they don't reduce the 33-URL miss list.

---

## Sprint Summary

| Sprint | Goal | Tasks | Complexity | Model |
|---|---|---|---|---|
| 0 | Prove WHERE current pipeline misses opera reviews (filter vs discovery vs extraction) | 3 | 2S, 1M | Sonnet |
| 1 | Pre-coding verification — confirm each new outlet's listing renders without auth | 1 | 1S | Sonnet |
| 2 | Add per-outlet opera endpoints (open-coded, no shared lib) | 11 | 9S, 2M | Opus |
| 3 | Cost guards: 24h cache + per-show SB cap + 21d window gate | 5 | 3S, 2M | Opus |
| 4 | Playbill opera roundup helper | 4 | 1S, 3M | Sonnet |
| 5 | Concurrency safety on push step | 3 | 1S, 2M | Opus |
| 6 | Critic registry updates | 2 | 2S | Sonnet |
| 7 | Feature flag + scoring-delta gate + soak + audit-regex | 5 | 4S, 1M | Sonnet |

**Total:** ~34 tasks across 8 sprints. Critical path: ~4 sequential sessions if Sprint 2 runs in one session.

## Sprint 0: Instrument before building
**Goal:** Output a 5×3 (show × bucket) table proving WHICH of the 17 known opera-review URLs are discovery-miss vs filter-miss vs extraction-miss in the CURRENT pipeline.
**Demo:** Markdown table committed as `data/audit/opera-discovery-gap-2026-05.md`. Discovery-miss column drives the rest of the plan; filter/extraction misses get filed as separate Notion cards.
**Risks:** If most misses turn out to be filter misses (e.g. `filterOperaUrls()` year-window too tight), Sprint 2 scope shrinks significantly — that's a win, not a problem.
**MODEL:** Sonnet — straightforward script, clear spec.

### Task S0-T1: Build the instrumentation script
- **Complexity:** M (one new file + reuse of existing pipeline functions)
- **Depends on:** None
- **Parallel:** No
- **Files:** `scripts/audit-opera-discovery-gap.js` (new)
- **Description:** One-shot Node script that, for a `--show=ID` flag, runs the EXISTING `gather-reviews.js` discovery (SERP + site-search) and dumps the raw URL list before any filter/ingest. Reuse `runDiscovery()` or equivalent — do not duplicate logic.
- **Acceptance criteria:**
  - VERIFY: `node scripts/audit-opera-discovery-gap.js --show=tristan-und-isolde-off-broadway-2026 --dry-run` outputs a JSON list of `{outlet, url, source}` to stdout.
  - VERIFY: `git diff` shows ONE new file, no edits to gather-reviews.js or site-search-discovery.js.

### Task S0-T2: Cross-reference against the 17 known URLs and bucket misses
- **Complexity:** S
- **Depends on:** S0-T1
- **Parallel:** No
- **Files:** `scripts/audit-opera-discovery-gap.js` (modify), `data/audit/opera-discovery-gap-2026-05.md` (new)
- **Description:** Extend the script to load the 17 ingested URLs from `data/review-texts/{5 met operas}/*.json`, diff against the discovery output, and bucket each URL as discovery-miss / filter-miss / extraction-miss. Filter-miss = URL appears in discovery output but doesn't get past `filterOperaUrls()` or the year-window. Extraction-miss = URL appears AND passes filter but the article-extractor returned empty (check `contentTier: 'invalid'` on existing files). Output a markdown table.
- **Acceptance criteria:**
  - VERIFY: `node scripts/audit-opera-discovery-gap.js --all` writes `data/audit/opera-discovery-gap-2026-05.md` with a 6-row × 3-bucket table.
  - VERIFY: Total bucketed URLs = 17 (or document why any are unattributable).

### Task S0-T3: Commit findings + narrow Sprint 2 scope
- **Complexity:** S
- **Depends on:** S0-T2
- **Parallel:** No
- **Files:** `data/audit/opera-discovery-gap-2026-05.md` (commit), `sprint-plan-opera-gather-tasks.md` (update Sprint 2 outlet list based on actual discovery-miss outlets)
- **Description:** Commit the audit table. If discovery-miss is <8 outlets, remove the others from Sprint 2 task list. If filter-miss accounts for ≥30% of the 17, file a Notion card to fix the filter rather than adding outlets.
- **Acceptance criteria:**
  - VERIFY: `git log -1 --stat` shows audit md + sprint plan update.
  - VERIFY: Notion card filed if filter-miss ≥30% (skip if 0).

---

## Sprint 1: Pre-coding verification
**Goal:** Confirm each Sprint-2 outlet's listing page actually renders opera reviews server-side without auth.
**Demo:** A screenshot or curl + grep proof per outlet committed to `data/audit/opera-outlet-verification.md`.
**Risks:** If a listing requires auth (e.g. Times-UK `/topic/classical-opera`), that outlet drops to data-debt Notion card. Better to find out before coding than after.
**MODEL:** Sonnet — verification only, no logic.

### Task S1-T1: Verify each Sprint-2 outlet URL renders without auth
- **Complexity:** S (one file, mechanical work)
- **Depends on:** S0-T3
- **Parallel:** No
- **Files:** `data/audit/opera-outlet-verification.md` (new)
- **Description:** For each outlet on the post-Sprint-0 list, `curl -sI` the listing URL with a real UA, confirm 200, then `curl -sL | grep -c review-url-pattern`. Record outcome per outlet. Mark blocked outlets data-debt.
- **Acceptance criteria:**
  - VERIFY: `cat data/audit/opera-outlet-verification.md` shows one row per outlet with status (OK / paywall / lazy-load / blocked) and URL count.
  - VERIFY: Any outlet not OK is filed on the existing data-debt Notion card (`363637c5-416f-8140-903a-e8b76518c6a0`).

---

## Sprint 2: Endpoint entries (open-coded, no shared lib)
**Goal:** Each discovery-miss outlet has a new entry in `SITE_SEARCH_ENDPOINTS` (or a sibling file for BWW Opera) that returns opera URLs.
**Demo:** `node scripts/gather-reviews.js --shows={5 met operas} --dry-run` (local) reports ≥85% recall against the 17 known URLs.
**Risks:** Per-outlet HTML drift mid-task; pagination differs per site; site-search-discovery.js conflict if subagents parallel-edit same file.
**MODEL:** Opus — pattern-matching against existing code, multi-file, error-prone.

Each task adds ONE outlet entry following the existing operawire (lines 507-531) or classical-voice-america (lines 587-607) shape. All entries:
- `applies: (show) => show.type === 'opera'`
- Pipe through `filterOperaUrls(urls, outletId, showId, openingDate)`
- Include pagination spec inline (max pages, stop-on-empty)
- **No** registry changes. **No** shared author-archive lib.

### Task S2-T1: Add Vulture opera endpoint
- **Complexity:** S
- **Depends on:** S0-T3 (scope narrowing)
- **Parallel:** No (same file as other S2 tasks)
- **Files:** `scripts/lib/site-search-discovery.js` (modify; insert in opera block)
- **Description:** Walk `https://www.vulture.com/author/justin-davidson/` (confirmed 33 article URLs returned via cookies-plain). Extract `/article/{slug}.html` patterns. Pipe through filterOperaUrls.
- **Acceptance criteria:**
  - VERIFY: `node -e "const { SITE_SEARCH_ENDPOINTS } = require('./scripts/lib/site-search-discovery'); SITE_SEARCH_ENDPOINTS.vulture.fetchAndParse('Tristan und Isolde', 'broadway', '2026-03-09', 'tristan-und-isolde-off-broadway-2026').then(r => console.log(r))"` returns the known Vulture Tristan URL.
  - VERIFY: Same call against a non-Met opera title returns 0 results (year-window filter works).

### Task S2-T2: Add New Yorker opera endpoint
- **Complexity:** S
- **Depends on:** S2-T1
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify)
- **Description:** Walk Alex Ross archive — known to be lazy-loaded. Plan: use `newyorker.com/tag/opera` listing page via Bright Data; per-author archive walk gated by `daysSinceOpening < 21` (added in Sprint 3) AND limited to 2 pages max.
- **Acceptance criteria:**
  - VERIFY: Direct call returns the known Tristan / Alex Ross URL.
  - VERIFY: Empty result for non-opera title.

### Task S2-T3: Add Washington Post opera endpoint
- **Complexity:** S
- **Depends on:** S2-T2
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify)
- **Description:** Walk `washingtonpost.com/people/philip-kennicott/` (cookies-plain confirmed working). Filter to opera review URLs.
- **Acceptance criteria:**
  - VERIFY: Direct call returns the known Tristan / Kennicott URL.

### Task S2-T4: Add FT opera endpoint
- **Complexity:** M (FT cookie-plain is flaky; needs fallback to Bright Data)
- **Depends on:** S2-T3
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify)
- **Description:** Try `ft.com/opera` listing + Andrew Farach-Colton author. If cookie-plain 403s, fall back to BD. URLs use `ft.com/content/{uuid}` pattern.
- **Acceptance criteria:**
  - VERIFY: Direct call returns the known Tristan / Farach-Colton URL.
  - VERIFY: Skips silently (returns `[]`) if both cookie and BD fail; no crash.

### Task S2-T5: Add Times (UK) opera endpoint
- **Complexity:** S
- **Depends on:** S2-T4
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify)
- **Description:** Walk `thetimes.com/topic/classical-opera`. Cookies-plain confirmed working in manual ingest.
- **Acceptance criteria:**
  - VERIFY: Direct call returns the known Tristan / Kevin Ng URL.

### Task S2-T6: Add Arts Desk opera endpoint
- **Complexity:** S
- **Depends on:** S2-T5
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify)
- **Description:** `theartsdesk.com/opera` category listing. Open access.
- **Acceptance criteria:**
  - VERIFY: Direct call returns the known Tristan / David Nice URL.

### Task S2-T7: Add TheaterMania opera endpoint
- **Complexity:** S
- **Depends on:** S2-T6
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify)
- **Description:** SERP query `{show title} site:theatermania.com` — they don't have a dedicated opera section, so SERP-only.
- **Acceptance criteria:**
  - VERIFY: Direct call against Kavalier returns the known TheaterMania URL.

### Task S2-T8: Add Observer opera endpoint
- **Complexity:** S
- **Depends on:** S2-T7
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify)
- **Description:** SERP query `{show title} site:observer.com Met opera`.
- **Acceptance criteria:**
  - VERIFY: Direct call against Kavalier returns the known Observer / Ferrari URL.

### Task S2-T9: Create `scripts/lib/bww-opera-discover.js` sibling file
- **Complexity:** M (new file matching `bww-rr-discover.js` pattern)
- **Depends on:** None (different file from S2-T1..T8, can be parallel)
- **Parallel:** Yes (different file — independent of T1-T8 chain)
- **Files:** `scripts/lib/bww-opera-discover.js` (new)
- **Description:** Mirror `scripts/lib/bww-rr-discover.js`. Scrape `broadwayworld.com/bwwopera/reviews` listing, title-match against show. Account for BWW soft-404 (`feedback_aggregator_soft_404.md`) by checking `<title>`, not status code.
- **Acceptance criteria:**
  - VERIFY: Direct call against Frida returns the known BWW Sasanow Frida URL.
  - VERIFY: BWW homepage soft-404 returns `[]`, not the homepage.

### Task S2-T10: Wire bww-opera-discover into gather-reviews.js
- **Complexity:** S
- **Depends on:** S2-T9
- **Parallel:** No
- **Files:** `scripts/gather-reviews.js` (modify; add import + call site)
- **Description:** Mirror the existing bww-rr-discover call site. Gate `show.type === 'opera'`.
- **Acceptance criteria:**
  - VERIFY: `grep -n "bww-opera-discover" scripts/gather-reviews.js` returns ≥2 matches (import + call).
  - VERIFY: Dry-run on Frida includes BWW Opera URL in output.

### Task S2-T11: Sprint 2 recall verification
- **Complexity:** S
- **Depends on:** S2-T1..T10
- **Parallel:** No
- **Files:** None (verification only)
- **Description:** Run the full dry-run locally (not CI) against the 5 Met operas. Confirm ≥85% recall against the 17 known URLs.
- **Acceptance criteria:**
  - VERIFY: `node scripts/gather-reviews.js --shows={5 met operas} --dry-run 2>&1 | tee /tmp/sprint2-recall.log` shows ≥15/17 known URLs in output.
  - VERIFY: Any miss is documented (was it expected? in scope?).

---

## Sprint 3: Cost guards
**Goal:** No matter how many opera shows are active, Sprint 2 endpoints can't blow the SB budget.
**Demo:** Running the dry-run twice in a row consumes credits only on the first run; second run is fully cached.
**Risks:** Cache invalidation bugs (stale URLs); cache directory grows unbounded; SB cap halts gather mid-show.
**MODEL:** Opus — cache infrastructure + budget integration is error-prone.

### Task S3-T1: Build `scripts/lib/opera-discovery-cache.js`
- **Complexity:** M (new helper, must be correct)
- **Depends on:** S2-T11
- **Parallel:** No
- **Files:** `scripts/lib/opera-discovery-cache.js` (new), `data/cache/opera-discovery/.gitignore` (new — ignore everything in dir)
- **Description:** Filesystem cache. Key: `{outlet}-{showId}-{YYYYMMDD}.json`. TTL: 24h. API: `withCache(key, fn)` returns cached value if fresh, else calls fn and writes. Atomic write via tmpfile + rename.
- **Acceptance criteria:**
  - VERIFY: Unit test: first call invokes inner fn once; second call within 24h does not.
  - VERIFY: `data/cache/opera-discovery/.gitignore` contains `*` so cache files aren't committed.

### Task S3-T2: Wire cache into each Sprint 2 endpoint
- **Complexity:** M (touches 10 sites — mechanical but high count)
- **Depends on:** S3-T1
- **Parallel:** No (same file again)
- **Files:** `scripts/lib/site-search-discovery.js` (modify), `scripts/lib/bww-opera-discover.js` (modify)
- **Description:** Wrap each new endpoint's `fetchAndParse` body in `withCache()`. Existing 7 opera outlets stay uncached (no regression).
- **Acceptance criteria:**
  - VERIFY: `grep -c "withCache" scripts/lib/site-search-discovery.js` returns ≥9 (one per new entry).
  - VERIFY: Dry-run twice; second run logs `[cache HIT]` for each new outlet.

### Task S3-T3: Add `SB_PER_SHOW_CAP=30` enforcement in gather-reviews.js
- **Complexity:** S
- **Depends on:** S2-T11 (independent of S3-T1)
- **Parallel:** Yes (different concern from cache)
- **Files:** `scripts/gather-reviews.js` (modify)
- **Description:** Track SB credit consumption per show. On exceeding cap, log warning, skip remaining opera-only endpoints for that show, continue to next show. Default cap configurable via env.
- **Acceptance criteria:**
  - VERIFY: `grep -n "SB_PER_SHOW_CAP" scripts/gather-reviews.js` returns ≥2 matches.
  - VERIFY: Dry-run with `SB_PER_SHOW_CAP=1` halts on first SB call per show, logs the cap.

### Task S3-T4: Add `daysSinceOpening < 21` gate to each Sprint 2 endpoint
- **Complexity:** S
- **Depends on:** S3-T2
- **Parallel:** No (same file)
- **Files:** `scripts/lib/site-search-discovery.js` (modify), `scripts/lib/bww-opera-discover.js` (modify)
- **Description:** Top of each new `fetchAndParse`: if `daysSinceOpening(openingDate) > 21`, return `[]`. Existing 7 opera outlets unchanged.
- **Acceptance criteria:**
  - VERIFY: Direct call with openingDate 60 days ago returns `[]` immediately, no fetch.
  - VERIFY: Direct call with openingDate 7 days ago returns expected URLs.

### Task S3-T5: Cache-hit verification end-to-end
- **Complexity:** S
- **Depends on:** S3-T4
- **Parallel:** No
- **Files:** None
- **Description:** Run dry-run on 5 Met operas twice. Compare SB credit consumption.
- **Acceptance criteria:**
  - VERIFY: First run consumes >0 SB credits; second run consumes 0.
  - VERIFY: `ls data/cache/opera-discovery/ | wc -l` matches expected entry count.

---

## Sprint 4: Playbill opera roundup helper
**Goal:** When a Met opera has a Playbill "what did critics think" article, pull every cited outlet URL out before per-outlet fan-out.
**Demo:** Running discovery on Tristan emits the FT + Vulture + Operawire + Bachtrack URLs found in Playbill's Tristan roundup, suppressing later redundant fetches.
**Risks:** Playbill markup changes; roundup doesn't exist for every show; URL extraction false-positives.
**MODEL:** Sonnet — clear spec, mirrors existing `playbill-verdict-discover.js`.

### Task S4-T1: Manually verify Playbill roundups exist for the 5 Met operas
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes (independent of Sprints 2-3)
- **Files:** `data/audit/playbill-roundup-coverage.md` (new)
- **Description:** Manually search Playbill for "what did critics think of X" and "reviews are out for X" article matches per Met opera. Record URLs (or "none found").
- **Acceptance criteria:**
  - VERIFY: `data/audit/playbill-roundup-coverage.md` lists each of the 5 operas + Innocence with a Playbill URL or `none`.
  - VERIFY: At least 3 of 6 have a roundup URL (else this sprint scope-cuts to data-debt).

### Task S4-T2: Create `scripts/lib/playbill-roundup-discover.js`
- **Complexity:** M (new file modeled on playbill-verdict-discover.js)
- **Depends on:** S4-T1
- **Parallel:** No
- **Files:** `scripts/lib/playbill-roundup-discover.js` (new)
- **Description:** Search Playbill via `playbill.com/search?q={show title} reviews` or category page. Match article titles against `"reviews are out for X"` / `"what did critics think of X"` patterns. For matching article, fetch it and extract outlet anchor hrefs (filter to known opera-reviewing outlet domains).
- **Acceptance criteria:**
  - VERIFY: `node -e "const { discoverPlaybillRoundup } = require('./scripts/lib/playbill-roundup-discover'); discoverPlaybillRoundup({title:'Tristan und Isolde', id:'tristan-und-isolde-off-broadway-2026', type:'opera', openingDate:'2026-03-09'}).then(console.log)"` returns the 4 outlet URLs found in the Playbill Tristan roundup.

### Task S4-T3: Wire playbill-roundup-discover into gather-reviews.js BEFORE per-outlet fan-out
- **Complexity:** M (placement-sensitive)
- **Depends on:** S4-T2, S2-T11 (so fan-out exists to suppress)
- **Parallel:** No
- **Files:** `scripts/gather-reviews.js` (modify)
- **Description:** Call playbill-roundup discovery early in opera-specific discovery flow. URLs found here flow into the same dedup/ingest path; later fan-out skips outlets already-seen.
- **Acceptance criteria:**
  - VERIFY: Dry-run on Tristan logs `[playbill-roundup] found 4 URLs` before any per-outlet fetcher fires.
  - VERIFY: Per-outlet fetchers for outlets already-seen via Playbill log `[skip — already discovered]`.

### Task S4-T4: 404-handling and graceful-no-roundup behavior
- **Complexity:** S
- **Depends on:** S4-T3
- **Parallel:** No
- **Files:** `scripts/lib/playbill-roundup-discover.js` (modify)
- **Description:** Confirm script returns `[]` (not a crash, not null) when no roundup exists for a show. Confirm 404 on the search endpoint doesn't fail the gather pass.
- **Acceptance criteria:**
  - VERIFY: Dry-run on a non-existent show ID returns `[]`, gather pass continues.

---

## Sprint 5: Concurrency safety
**Goal:** Two cron ticks racing on `data/review-texts` can't silently delete each other's new files.
**Demo:** Manually triggering two `gather-reviews.yml` runs 30s apart, both runs' new files survive.
**Risks:** Concurrency group blocks legitimate parallel discovery; post-rebase check has false positives.
**MODEL:** Opus — workflow YAML + git retry is high-blast-radius.

### Task S5-T1: Add concurrency group to gather-reviews.yml push step
- **Complexity:** S
- **Depends on:** None (independent of code Sprints 2-4)
- **Parallel:** Yes (workflow YAML only)
- **Files:** `.github/workflows/gather-reviews.yml` (modify)
- **Description:** Add `concurrency: group: data-review-texts-push` scoped to the push step (or split push into a separate job with that concurrency). Discovery itself can run parallel; only push serializes.
- **Acceptance criteria:**
  - VERIFY: `gh workflow view gather-reviews.yml` shows the concurrency block.
  - VERIFY: Manual trigger of 2 runs 30s apart shows the second's push step queued, not racing.

### Task S5-T2: Build per-file post-rebase check script
- **Complexity:** M (small script but easy to get wrong)
- **Depends on:** None
- **Parallel:** Yes (separate file)
- **Files:** `scripts/check-post-rebase-survival.js` (new)
- **Description:** Given a list of files we just staged, after the rebase confirm each is still present on HEAD with our content. If any file is missing, exit nonzero with file list. No `|| true`.
- **Acceptance criteria:**
  - VERIFY: Manual test: stage 3 files, rebase, delete one mid-flight; script reports the missing file with nonzero exit.

### Task S5-T3: Wire post-rebase check into gather-reviews.yml
- **Complexity:** S
- **Depends on:** S5-T2, S5-T1
- **Parallel:** No
- **Files:** `.github/workflows/gather-reviews.yml` (modify)
- **Description:** Run check immediately after the rebase step in gather-reviews.yml. Fail the workflow loud on miss.
- **Acceptance criteria:**
  - VERIFY: Forced-conflict integration test: simulate a rebase that drops a file; workflow fails with `check-post-rebase-survival.js` in the failure summary.

---

## Sprint 6: Critic registry updates
**Goal:** New author bylines (Davidson, Ross, Kennicott, Farach-Colton, Sasanow for BWW Opera) are in `critic-outlets.json` so URL-date guards don't filter them as Unknown.
**Demo:** `grep` proves each new critic row exists in BOTH the main repo and the dual-repo copy.
**Risks:** Dual-repo desync (`feedback_outlet_registry_dual_repo.md`).
**MODEL:** Sonnet — pure data edit.

### Task S6-T1: Add 5 critic rows to `data/critic-outlets.json`
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `data/critic-outlets.json` (modify)
- **Description:** Add rows for `justin-davidson` (vulture), `alex-ross` (newyorker), `philip-kennicott` (washpost), `andrew-farach-colton` (financialtimes), `richard-sasanow` (broadwayworld bwwopera). Match existing schema. Waleson skipped — already in registry from prior plays/musicals work.
- **Acceptance criteria:**
  - VERIFY: `for c in justin-davidson alex-ross philip-kennicott andrew-farach-colton richard-sasanow; do grep -c "\"$c\"" data/critic-outlets.json; done` each returns ≥1.

### Task S6-T2: Sync to dual repo
- **Complexity:** S
- **Depends on:** S6-T1
- **Parallel:** No
- **Files:** `~/broadway-scorecard-data/critic-outlets.json` (copy + commit)
- **Description:** Mirror the edit to the private data repo. Push.
- **Acceptance criteria:**
  - VERIFY: `diff data/critic-outlets.json ~/broadway-scorecard-data/critic-outlets.json` returns empty.
  - VERIFY: `cd ~/broadway-scorecard-data && git log -1 --stat` shows the critic-outlets.json commit pushed.

---

## Sprint 7: Feature flag + scoring-delta gate + soak + audit-regex
**Goal:** Roll out V2 safely behind a flag, verify no unintended score flips, complete CLAUDE.md-mandated audits, then flip default.
**Demo:** `OPERA_DISCOVERY_V2=1` set in workflow env for 1 week; scoring-delta shows only opera-show flips; after 1 week, flag flipped to default.
**Risks:** Soak reveals a regression too late; flag not honored by some endpoint = no rollback path.
**MODEL:** Sonnet — config + monitoring.

### Task S7-T1: Add `OPERA_DISCOVERY_V2` env gate to each new endpoint
- **Complexity:** S
- **Depends on:** S3-T4, S2-T10
- **Parallel:** No (touches same file as Sprint 2/3)
- **Files:** `scripts/lib/site-search-discovery.js` (modify), `scripts/lib/bww-opera-discover.js` (modify), `scripts/lib/playbill-roundup-discover.js` (modify)
- **Description:** Top of each new endpoint's `fetchAndParse`: `if (process.env.OPERA_DISCOVERY_V2 !== '1') return [];`. Existing 7 opera outlets are unchanged.
- **Acceptance criteria:**
  - VERIFY: Without env, dry-run returns 0 URLs from new endpoints.
  - VERIFY: With env=1, dry-run returns the Sprint 2 recall set.

### Task S7-T2: Run `audit-regex-patterns.js --full`
- **Complexity:** S
- **Depends on:** S2-T10 (all new patterns landed)
- **Parallel:** Yes (independent)
- **Files:** None (audit only)
- **Description:** CLAUDE.md rule 12.8 mandates after URL-pattern changes. Document any bare-keyword FPs found.
- **Acceptance criteria:**
  - VERIFY: `node scripts/audit-regex-patterns.js --full` exits 0.
  - VERIFY: Any new warnings filed on a Notion follow-up card.

### Task S7-T3: Run scoring-delta before flipping flag default
- **Complexity:** S
- **Depends on:** S7-T1
- **Parallel:** No
- **Files:** None
- **Description:** Run `node scripts/scoring-delta.js` after a live (non-dry) cron tick with V2 enabled. Inspect any T1 flips on shows OTHER than the 5 Met operas — those need explanation.
- **Acceptance criteria:**
  - VERIFY: Delta summary shows newly-included reviews concentrated on opera shows.
  - VERIFY: Any non-opera T1 flip is investigated; if intentional, documented; if not, V2 rolled back.

### Task S7-T4: Set `OPERA_DISCOVERY_V2=1` in workflow env for 1-week soak
- **Complexity:** S
- **Depends on:** S7-T3
- **Parallel:** No
- **Files:** `.github/workflows/gather-reviews.yml` (modify)
- **Description:** Add `env: OPERA_DISCOVERY_V2: '1'` to the gather-reviews job.
- **Acceptance criteria:**
  - VERIFY: First post-merge cron tick logs `[OPERA_DISCOVERY_V2 enabled]` from a new endpoint.

### Task S7-T5: After 1-week soak, flip default + remove flag plumbing
- **Complexity:** M (cleanup pass)
- **Depends on:** S7-T4 + 7-day wait
- **Parallel:** No
- **Files:** `scripts/lib/site-search-discovery.js`, `scripts/lib/bww-opera-discover.js`, `scripts/lib/playbill-roundup-discover.js`, `.github/workflows/gather-reviews.yml` (all modify)
- **Description:** Remove env-gate from each endpoint. Remove env line from workflow. Delete feature flag — V2 is now default.
- **Acceptance criteria:**
  - VERIFY: `grep -c "OPERA_DISCOVERY_V2" scripts/` returns 0.
  - VERIFY: Cron tick after merge still produces expected V2 URLs.

---

## Phase 3: Self-validation checklist

1. **Completeness:** Sprints in order, each builds on prior. Sprint 0 produces evidence; Sprint 1 verifies before coding; Sprints 2-5 add capability; Sprint 6 keeps the registry honest; Sprint 7 rolls out safely. **PASS.**
2. **Atomicity:** Every task is one commit-worthy concern. No "and" titles except S6-T1 (5 critics in one row-add = one commit; acceptable). **PASS.**
3. **Dependency chain:** S0→S1→S2→{S3,S4}→S5→S6→S7. S2 internal: T1..T8 chain on same file; T9 parallel; T10 depends on T9; T11 closes. No circular deps. **PASS.**
4. **Test coverage:** Every task has a `VERIFY` that is a runnable command or grep. **PASS.**
5. **Missing work:** Critic-outlets dual-repo sync ✓, audit-regex-patterns ✓, rollback ✓, scoring-delta gate ✓, BWW soft-404 handled in S2-T9, paywall verification done in S1, pagination spec required per S2 task. **PASS.**
6. **Ordering:** Sprint 0 first is correct — could cut scope by half. Sprint 1 before Sprint 2 is correct — don't code against a paywall-walled listing. **PASS.**
7. **Parallel workstreams:** S2-T9 (BWW sibling) runs parallel with S2-T1..T8 (different file). S3-T1 + S3-T3 are different files. S4-T1 + S5-T1/T2 are independent of Sprints 2-3. S6 is independent. See subagent map below. **PASS.**
8. **Manual before automated:** Sprint 0 manual analysis before any new code. Sprint 1 manual listing-page verification before per-outlet code. **PASS.**
9. **Scale check:** Cost guards in Sprint 3 explicitly target 10x scale (cap, cache, day-window). **PASS.**

All checks pass.

## Phase 3.5: Model recommendation per sprint

| Sprint | Model | Reason |
|---|---|---|
| 0 | Sonnet | Straightforward script, clear spec, no architectural choices |
| 1 | Sonnet | Verification only, no logic |
| 2 | Opus | Multi-file pattern-matching across 10 outlets; gotchas in each (FT paywall, BWW soft-404, Vulture canonical URL, lazy-loaded archives); easy to introduce silent regressions |
| 3 | Opus | Cache infrastructure correctness + budget plumbing; cache invalidation is canonical hard problem |
| 4 | Sonnet | Mirrors existing `playbill-verdict-discover.js` shape — well-defined |
| 5 | Opus | Workflow YAML + git retry is high blast-radius; concurrency groups have subtle semantics |
| 6 | Sonnet | Pure data edit, well-known schema |
| 7 | Sonnet | Config edits + running existing scripts |

---

## Dependencies graph

```
S0-T1 → S0-T2 → S0-T3
                  ↓
                S1-T1
                  ↓
        ┌────────┼────────────────┐
        ↓        ↓                ↓
   S2-T1..T8  S2-T9        S4-T1 (parallel verification)
        ↓        ↓                ↓
        └→ S2-T10 → S2-T11        S4-T2
                       ↓             ↓
                  ┌────┴────┐     S4-T3 ← needs S2-T11
                  ↓         ↓        ↓
                S3-T1     S3-T3   S4-T4
                  ↓
                S3-T2
                  ↓
                S3-T4 → S3-T5

S5-T1 (parallel from S0-T3) ─→ S5-T3
S5-T2 (parallel from S0-T3) ─┘

S6-T1 (parallel from start) → S6-T2

S7-T1 needs all of {S2-T10, S3-T4} → S7-T2 (parallel: just audit-regex) → S7-T3 → S7-T4 → wait 7d → S7-T5
```

## Subagent execution map (within one /execute-plan session)

```
Subagent track 1 (Vulture/NY/WaPo/FT/Times/ArtsDesk/TheaterMania/Observer chain — site-search-discovery.js serial):
  S0-T1 → S0-T2 → S0-T3 → S1-T1 → S2-T1 → S2-T2 → S2-T3 → S2-T4 → S2-T5 → S2-T6 → S2-T7 → S2-T8 → S2-T11

Subagent track 2 (BWW Opera sibling — different file):
                                            S2-T9 → S2-T10 ────────────────┐

Subagent track 3 (Playbill verify + helper — different files):
                            S4-T1 → S4-T2 → S4-T3 → S4-T4 ──────────────────┤

Subagent track 4 (Concurrency safety — workflow + new script):
                            S5-T1 ──────────────────────────────────────────┤
                            S5-T2 → S5-T3 ──────────────────────────────────┤

Subagent track 5 (Critic registry — data file only):
                            S6-T1 → S6-T2 ──────────────────────────────────┤

Sync after Sprint 2:                                       ─── all tracks rejoin ───
                                                                ↓
                                                        S3-T1 → S3-T2 → S3-T4 → S3-T5
                                                        S3-T3 (parallel)
                                                                ↓
                                                        S7-T1 → S7-T2 (parallel) → S7-T3 → S7-T4 → [7d wait] → S7-T5
```

**Parallel sprints (subagent-level, same session):** Sprints 4, 5, 6 can run as concurrent tracks within one execute-plan session after Sprint 0+1 completes. Sprint 2 itself has track 1 (8 outlets serial) + track 2 (BWW sibling, parallel).

**Critical path:** S0 → S1 → S2 (T1-T11) → S3 → S7 → 7-day soak → S7-T5. About 4 sessions minimum:
- **Session 1:** Sprint 0 + Sprint 1 (instrumentation + verification). Ships findings to main.
- **Session 2:** Sprint 2 entirely (all endpoints + sibling file + recall verify). Ships to main.
- **Session 3:** Sprints 3 + 4 + 5 + 6 in parallel subagent tracks. Ships to main.
- **Session 4:** Sprint 7 T1-T4 (flag on + scoring-delta + soak start). 7-day wait. Then Sprint 7 T5 in a brief session.

**Max subagent parallelism:** 5 concurrent tracks at the Sprint 3+4+5+6 sync point.

**Cross-session plan:** see "Critical path" — one sprint group per session, each ships and pushes before the next session starts. Multi-session work is sequential at the session level; intra-session parallelism is subagent-only.

## Known edge cases

- **BWW soft-404:** BroadwayWorld returns homepages with 200 OK for missing URLs. S2-T9 must check `<title>` content, not status code.
- **Vulture canonical URL:** Vulture's URL verifier rejects URLs without `www.` prefix. S2-T1 must use `https://www.vulture.com/...`.
- **FT cookies flaky:** FT `cookie-plain` 403s on listing pages even with fresh cookies — S2-T4 needs BD fallback path.
- **Times-UK paywall on topic pages:** Sprint 1 will determine whether listing pages render server-side. If not, drop to data-debt.
- **Filter-miss vs discovery-miss confusion:** Sprint 0's bucketing must distinguish "URL was returned by SERP but `filterOperaUrls()` dropped it for year-window" from "URL was never returned." Different fix.
- **`daysSinceOpening` for revivals:** If a Met production is itself a revival (e.g. Eugene Onegin 2026 was a Deborah Warner revival), `openingDate` in `shows.json` is the 2026 opening, not the original 2013 production. Confirm this is what's used in `filterOperaUrls()` already.
- **WSJ data-debt unblock:** When user refreshes WSJ subscriber cookies (Notion card `363637c5-416f-8140-903a-e8b76518c6a0`), running `recover-wsj-subscriber.js` will retroactively fill teaser-only WSJ files; that's a separate one-off, not part of this plan.

## Changes from /plan-review critique

| Change | Reason | Source |
|---|---|---|
| Dropped `outlet-registry.json coverage.opera` flag | P0 — invents parallel gating; `applies:` predicate already self-gates | Code Design |
| Dropped shared `author-archive-discovery.js` lib | Premature abstraction — 5 sites, 5 different HTMLs | Code Design, Codex |
| Added Sprint 0 instrumentation pass | May cut Sprint 2 scope in half if misses are filter bugs not missing outlets | Codex |
| Added Sprint 3 cost guards | Pre-mortem caught $890 BD spike scenario from uncached author-archive walks | Pre-mortem |
| Added Sprint 5 concurrency safety | 30% silent data loss from parallel `git push` retries with `-X theirs` | Pre-mortem, Codex |
| Verification moved local, not CI | One-time backfill; faster, no push races | Codex, Pre-mortem |
| WSJ out of Sprint 2 | CI IP block + non-subscriber cookies | Claude, this session's evidence |
| Added Sprint 6 critic-outlets dual-repo sync | URL-date guard filters Unknown bylines | Claude |
| Added Sprint 7 audit-regex-patterns | CLAUDE.md rule 12.8 mandate | Claude |
| Added Sprint 1 incognito verification | Multiple paywalls/lazy-loaded pages caught only when coding | User Impact |
| BWW Opera as sibling file (S2-T9), not inline endpoint | Matches `bww-rr-discover.js` pattern | Code Design |
| Reordered: audits before flag-default flip | Logical dependency — soak validates audited code | Self-validation |

## Key risks

1. **Sprint 0 reveals filter-miss is the real problem.** If ≥30% of misses are `filterOperaUrls()` dropping legitimate URLs, this whole plan refocuses on filter fixes (much smaller scope). Acceptable outcome — file it as a Notion follow-up and proceed with the remaining outlet additions.
2. **SB credit budget still blows up despite Sprint 3 guards.** Mitigation: Sprint 7's 1-week soak with monitoring; `SB_PER_SHOW_CAP` is the hard backstop.
3. **Concurrent gather-reviews.yml runs corrupt the data repo.** Sprint 5 addresses this, but the existing `gather-reviews.js` raw `fs.writeFileSync` paths (3386, 3399, 3639, 3644) are not touched by this plan. If concurrency issues persist, follow-up plan needed to migrate those writes to the `review-write-guard.js` lock-safe contract.

---

Use subagents liberally for Sprints 2-6.
