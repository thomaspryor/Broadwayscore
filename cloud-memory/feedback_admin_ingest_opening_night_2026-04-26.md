---
name: Joe Turner Opening Night 2026-04-25/26 — MASTER ISSUE LOG
description: Consolidated defect log from BOTH parallel sessions covering opening-night automation for joe-turners-come-and-gone-2026. 40+ distinct issues. Status, fixes, owners, commits.
type: feedback
originSessionId: df38a69c-7134-46bc-96cb-094d85aff0b2
---
Joe Turner's Come and Gone opened 2026-04-25 (8 PM ET curtain, embargo lifted ~10 PM ET, BWW RR published ~10:25 PM ET). Two Claude sessions worked the night in parallel:
- **Session A** ("admin-ingest" — this file's primary author): drove the user's batch via the admin UI, recovered stripped data, patched the push-action.
- **Session B** ("RHS / aggregator watcher"): pre-opening fix audit + ran the BWW homepage matcher fix + monitored aggregator pipeline.

This file unifies findings from both sessions. **Numbering preserved from each source** (RHS #N from B's pre-opening audit, Tonight #N from B's live audit, and #N from A's session).

---

## ✅ SHIPPED THIS CYCLE (workaround OR real fix landed)

### Discovery & aggregator watcher

**RHS #1 — BWW homepage matcher (Session B).** ✅ Shipped commits **8db7d252b5** (BWW homepage as primary discovery layer), **9bcd33cb9c** (use `fetchPage()` for CI 403 bypass).
Watcher's only BWW signal was a Browserbase scrape of `reviews.php`, which returned 6 anchors total, none matching joe-turner — but the BWW homepage carousel had the joe-turner Review Roundup as its top featured story (different cache lanes). Fix added `discoverBwwRoundupFromHomepage()` in `scripts/watch-aggregator-urls.js`. Plain HTTPS works locally; CI uses `fetchPage()` (Bright Data fallback). Verified caught joe-turner URL in 3 sec on next CI run.

**Tonight #1 — Watcher CI 403 on plain HTTPS to BWW homepage (Session B).** ✅ Shipped **9bcd33cb9c**.
Plain `https.get()` to broadwayworld.com/ returns 200 from a residential IP but 403 from GitHub Actions IPs (Cloudflare bot block — same pattern as `feedback_wsj_newyorker_ci_ip_block.md` + `feedback_tls_fingerprinting.md`). Fix: switched watcher's homepage scrape to `fetchPage()`. Cost ~$0.005/call via BD vs $0.10 for Browserbase. Wired BRIGHTDATA_TOKEN, BRIGHTDATA_ZONE, SCRAPINGBEE_API_KEY into the workflow env.

**Tonight #2 — Watcher dispatches don't set skip_serp=true (Session B).** ✅ Shipped **e306e20df6**.
When watcher dispatched the poller with a known-good `bww_roundup_url` override, SERP discovery still ran — wasted 3-5 min and could return wrong-production results that the poller then had to filter. Fix: when bwwRoundupUrl override is present, also pass `skip_serp=true`. Cuts discover-to-deploy from ~10-15 min → ~7-10 min.

**Tonight #3 — Watcher telemetry was misleading (Session B).** ✅ Shipped (in **cb128666ab**).
Logged "0 anchors checked" when 6 anchors were actually fetched but 0 matched. Made it look like Browserbase was failing when it was a no-match. Fix: log raw anchor count separately from filtered candidates; added `source` field ("homepage" vs "reviews.php") for diagnosis.

### Cloudflare / scraping

**RHS #4 — Cloudflare BWW SERP budget burn (Session B).** ✅ Shipped commits **00ee1da6dc** (Cloudflare short-circuit for `scrapeBWWRoundupWithPlaywright`), **190dd3fc0d** (Cloudflare gate on remaining BWW fetch paths + large-challenge detection), **a25fb1f45c** (BWW homepage scan reuses shared validator + Cloudflare short-circuit), **1946e05109** (wait for Cloudflare challenge to clear before reading reviews.php anchors).

### Aggregator extraction

**RHS #3 — NYSR star extractor not wired into collect path (Session B).** ✅ Shipped (Session B).
Actual gap was `ingest-manual-review.js`, not `collect-review-texts.js`. Pipeline path was already wired. Real-HTML test fixture, 12/12 tests pass.

### Pollers

**RHS #5 — Poller re-creates deleted files (Session B).** ✅ Shipped commits **fc1c6eed96** (feat), **c025f999ec** (ship-check P1s), **2a80f705d2** (Session 2 hardening). New `scripts/lib/poller-blocklist.js` + `scripts/block-review.js` CLI. Has unit test.

**Tonight #4 — Poller gate bug: unscored existing reviews stranded (Session B).** ✅ Shipped **371f2e745b**, merged **cfbe2e7b5f**. **P0 catch.**
Joe Turner had 4 review files collected pre-opening (deadline, frontmezzjunkies, playbill, theatrely) — all unscored. When BWW RR published, watcher dispatched poller. Poller extracted 1 critic block from BWW RR → deduped against existing outlet → CREATED=0 → ANY_NEW=false → all downstream steps SKIPPED:
- ❌ Commit new review files
- ❌ Score reviews inline
- ❌ Rebuild reviews.json
- ❌ Push core data
- ❌ Trigger deploy

The 4 existing unscored reviews stayed unscored. Auto-scoring threshold (`llm-ensemble-score.yml`) is 5+ unscored — under that threshold, nothing fires automatically.
Root cause: step gates at `if: steps.poll.outputs.any_new == 'true'` only fire when poll wrote NEW files. Existing-but-unscored don't trigger pipeline.
Fix: Added `ANY_READY` signal — per-show count of unscored reviews (no llmScore, no humanReviewScore, not flagged wrongProduction/wrongShow/isRoundupArticle). Combined with ANY_NEW into `ANY_ACTION`. Re-routed gates:
- `any_new` (kept): commit new files, collect text, commit text — fire only when files actually changed
- `any_action` (new): score reviews, commit scores, cancel rebuilds, fast_path rebuild, legacy rebuild dispatch, readiness check, broadcast trigger — fire on new OR existing-unscored

⚠ **Verification gap**: tested locally; CI verification pending the next opening with the same pattern.

### Admin ingest UI — detection (Session A)

**A #3 — URL-slug detection only looked at LAST path segment.** ✅ Shipped **c741ee089f**.
Cititour URL `cititour.com/NYC_Broadway/Joe-Turners-Come-and-Gone/1377` returned `1377` as slug → no match → fell back to text matching → wrong show. Fix walks all path segments + slugifies.

**A #4 — Text-substring show match picked wrong show when critics mention other plays.** ✅ Shipped **c741ee089f**.
6 of 9 batch reviews misattributed to Home/Outsiders/Purpose/Rocky Horror because Joe Turner critics mentioned those other shows. Fix: URL-slug priority over text-match + stricter text-match thresholds. Text-only matches now max out at "medium" confidence.

### Admin ingest UI — pull-quotes / score / Substack / byline (Session A, prior commits)

The original Alt 2 cycle shipped earlier this week:
- Substack subdomain auto-detection (`*.substack.com` → subdomain as outletId)
- "Posted by [Name] at TIME" Blogger byline pattern
- defaultCritic from outlet-registry.json wins over byline
- Score field accepts native formats (5/5 stars, ★★★★, A-) with /100 preview
- Submission log + retry-with-backoff + batch mode
- Per-entry overrides in batch (`Critic:`, `Show:`, `Score:`)
All shipped before tonight.

### Push protection (Session A)

**A #2 — push-review-texts action ignored protectedFields, stripped fullText.** ✅ Shipped **6c34f1ebf7** (post-incident).
Action's protection script only restored fields when local was `undefined`/`null`. Empty string `""` was NOT caught — so when rebuild wrote `fullText: ''`, this protection didn't fire. Fix: new `isEmpty()` helper covers undefined/null/empty-string/empty-array. New `_locked: true` per-file flag — when set, ALL protected fields where committed had content are restored unconditionally. Verified working: Culture Sauce file fullText 8000ch survived through a rebuild after patch landed.

---

## ⚠️ PARTIAL — workaround in place, real fix pending

**RHS #6 — CI rebuild auto-renames -2026 suffix (Session B).** ⚠ Partial.
No direct fix to the 95%-similarity rename logic in `rebuild-all-reviews.js`. Commit **d38add2da0** (`fix(enrich-thumbs): match year-suffix filenames via internal criticName`) paves over the thumb-enrichment side effect. Rebuild itself probably still renames.
Workaround: use `wrongProductionManualClear` / `protectedFields` arrays rather than rely on suffix-based protection.
Owner for next session: real fix to the rename logic.

**Tonight #5 — GH cron didn't fire on first activation (Session B).** ⏳ Open / partial.
New `aggregator-url-watcher.yml` workflow registered fine but `*/5 * * * *` cron didn't fire for 15+ min after deploy. Documented behavior per `memory/feedback_github_cron_delays.md` (crons can lag 30 min - 3h on first activation).
Mitigation tonight: session-scoped backup dispatcher (background bash loop dispatching every 5 min for 6 hours). Cosmetic fix only.
Owner for next session: verify cron is firing autonomously on the next opening night. If not, escalate to GH support or fall back to launchd.

---

## ❌ OPEN — P0 (must fix before next opening night)

**RHS #2 / Tonight #8 — Show Score extractor returns 0 reviews from HTML (Sessions A+B).** ❌ NOT shipped.
Zero commits to `searchShowScore` or `extractShowScoreReviews` in `scripts/gather-reviews.js` since RHS audit. HTML-structure-changed bug still live. Tonight's poller log: `⚠️ Show Score page loaded (212KB) but 0 reviews extracted — HTML structure may have changed`. Confirmed firing for Joe Turner.
Mitigation tonight: when orchestrator log shows Show Score: 0 reviews (HTML), treat as known false-zero and manually spot-check the page.
Owner for next session: P0. Inspect Show Score's current DOM, update extractor selectors.

**A #1 — opening-night-poller strips user-submitted fullText (Session A).** ❌ Open.
Its `collect-review-texts` step writes the file back with empty `fullText` when scraper returns nothing for the URL, even when file already had user-pasted text. Pattern: file has fullText 6475ch → poller runs → file has fullText 0ch.
Partially mitigated by Session A's push-action patch (#A2) — empty-string overwrites are now caught at push time. But the underlying poller behavior of writing empty content needs fixing.
Fix: `scripts/lib/scraper.js` callers (or `collect-review-texts.js`) must NEVER write `fullText: ''` over an existing non-empty value. Honor `_locked: true` and `manualContentTier: complete` flags.

**A #18 — Daily 4 AM full rebuild has its OWN enrichment chain that may strip `_locked` files (Session A).** ❌ Open. **TONIGHT'S RISK.**
`rebuild-reviews.yml` runs classify-non-reviews, flag-wrong-production-by-date, audit-pre2005, classify-wrong-production, classify-wrong-show, backfill-unknown-critics, cleanup-phantom-outlets, strip-stale-single-model-scores, detect-syndicated-duplicates, apply-audit-flags. Push-review-texts patch (6c34f1ebf7) protects against EMPTY-string overwrites, but each enrichment script may write its OWN content (not empty) that fails the protection check.
Fix: audit each enrichment script and ensure (a) reads `_locked` before writing, (b) preserves protected fields when its update has lower confidence than existing data. Consider top-level guard in `rebuild-all-reviews.js` that short-circuits enrichment for `_locked: true` files.

**Tonight #7 — Push race conflicts between concurrent pollers and manual ingest (Session B).** ❌ Open.
With 3 pollers in-flight at the same time as user's manual admin-ingest UI submissions, all writing to broadway-review-texts private repo, 5-attempt push retry exhausted → push failure on the skip_serp poller (24945945021). LLM scoring run also hit `HTTP 403: API rate limit exceeded for installation` on its post-scoring rebuild dispatch step.
Root cause: multiple concurrent writers to the same private repo branch with no coordination beyond sequential rebase-and-retry. Storm of pushes within ~10 min.
Mitigation tonight: failed steps were non-blocking; later rebuilds picked up the data.
Owner for next session — two threads:
- (a) tighter concurrency group on poller — only one in-flight at a time, OR
- (b) watcher idempotency — skip dispatching when a poller is already in-flight for that show

**A #19 — No opening-night completeness alerting (Session A).** ✅ Shipped commit **f7993cc63e** (2026-04-26).
Operator manually noticed Culture Sauce was missing from live page. Now: `scripts/check-opening-night-completeness.js` snapshots the per-show critic set `(outletId, criticName)` from reviews.json on every run and diffs against `data/audit/opening-night-completeness-state.json`. Any disappearance → Discord alert (warning, 60-min per-show cooldown). Fires on `*/15 * * * *` cron via `opening-night-completeness-check.yml` AND as a post-rebuild step in both `rebuild-fast.yml` and `rebuild-reviews.yml`. No aggregator fetches — pure snapshot diff is fast enough to run every 15 min for free. The cron skips when a rebuild is in flight (the rebuild's own post-step has fresher data).

**A #20 — No alert when review count drops in reviews.json (Session A).** ✅ Shipped commit **f7993cc63e** (2026-04-26).
Same script as A #19, additionally consumes `data/audit/rebuild-regression.json` when written ≤30 min ago. For shows in the ±7d opening-night window, ANY per-show drop fires the alert (the existing `analyze-rebuild-drops.js` only fires above 30 total / 10 single-show, which masked Joe Turner's 14→12). Wired into `rebuild-fast.yml` (which previously had no drop alerting at all) AND `rebuild-reviews.yml` as a step right after `analyze-rebuild-drops.js`. Strict + cooldowned so a multi-rebuild night doesn't spam.

**A #21 — Multiple consecutive rebuild timeouts → NO deploys fire (Session A).** ❌ Open.
vercel-deploy's workflow_run trigger gates on `conclusion == 'success'`. When 3+ rebuilds in a row time out at 10 min, all 3 deploys are skipped. Operator must manually `gh workflow run vercel-deploy.yml`. Saw this happen multiple times tonight under push contention.
Fix options:
- (a) bump rebuild-fast timeout 10 → 20 min, OR
- (b) deploy on `conclusion in ['success','timed_out']` (reviews.json was committed before timeout in observed cases), OR
- (c) separate "deploy-on-data-change" trigger watching broadway-scorecard-data for new commits to reviews.json and dispatching deploys directly.

---

## ❌ OPEN — P1 (should fix soon)

**Tonight #6 — BWW reviews.php returns only 6 anchors total (Session B).** ⏳ Open (low priority — homepage now primary).
When Browserbase scrapes `/reviews/`, anchor list contains only 6 Review-Roundup URLs. CSS selector may be too narrow (lazy-loaded list?) or BWW intentionally shows only newest few.
Impact reduced by: tonight's BWW homepage fix (homepage primary; reviews.php fallback).
Owner for next session: look at `scripts/lib/bww-rr-discover.js:fetchReviewsPageAnchors` selector if reviews.php fallback ever needs to do real work.

**A #5 — rebuild-fast does NOT extract pull-quotes (Session A).** ⏳ Open.
Only `Rebuild Reviews Data` (full, ~30min) does. Newly-ingested reviews lack pull-quotes until daily 4 AM rebuild OR explicit `extract-pull-quotes.yml` dispatch.
Fix: either add the pull-quote step to fast rebuild, or have admin-ingest auto-dispatch extract-pull-quotes after the file commit.

**A #6 — rebuild-fast does NOT auto-dispatch LLM scoring (Session A).** ⏳ Open.
Only full `rebuild-reviews.yml` does. Newly-ingested reviews need a separate `LLM Ensemble Score Reviews` dispatch.
Fix: admin-ingest should auto-dispatch llm-ensemble-score after file commit (with show_id filter).

**A #7 — rebuild-fast push step times out on contention (Session A).** ⏳ Open. (Related to RHS Tonight #7 push race.)
Saw `Commit and push changes` take 7+ min during heavy concurrent activity, hitting 10-min `timeout-minutes`. When timed out, conclusion=cancelled → workflow_run-triggered deploy SKIPS.
Fix: bump `timeout-minutes: 10` → 20 OR separate "deploy if reviews.json was committed" step.

**A #8 — Cross-production validation missing (Session A).** ⏳ Open.
A Substack review of Cincinnati regional Rocky Horror auto-attributed to Broadway 2026 because both share the title. Admin UI's `wrongProductionManualClear: true` BYPASSES rebuild's wrongProduction guards. If user ingests a wrong-production review, system has no way to catch it.
Fix: before committing, cross-check (a) URL domain × show market, (b) any cast/director names in text against known cast for the show, (c) URL date vs production preview/closing window. Warn user before commit.

**A #9 — NYT Critics_Pick designation not auto-detected (Session A).** ⏳ Open.
Helen Shaw's URL/text both contain "Critic's Pick" markers (`Critic's Pick` in headline, `criticsPick` CSS class) but admin ingest didn't set `designation: 'Critics_Pick'`. Required manual write. Floor (70) + bump (+3) = max 73 effective floor for a Critics' Pick reads as conservative.
Fix: admin-ingest detect step should check NYT URLs for "Critic's Pick" markers (regex on text or HTML) and auto-set designation.

**A #16 — BWW RR discovered URL but full text never collected for Culture Sauce (Session A).** ⏳ Open.
URL `culturesauce.com/.../#google_vignette` was correctly captured from BWW RR scrape (excerpt + thumb stored). But `collect-review-texts.js` failed to fetch the body — file sat with `fullText: 0ch` for hours. Manual `fetchPage` via Bright Data succeeded with the SAME URL, returning 8000+ chars. Likely root causes:
- The empty-write bug (#A1) — scraper returned nothing → poller wrote empty back
- URL fragment `#google_vignette` may break URL normalization in scraper or dedup
Fix: (a) fix #A1, (b) strip URL fragments before any URL-keyed lookup or write.

**A #17 — Misattributed full-text in batch paste silently excludes review (Session A).** ⏳ Open.
User's batch had Brian Scott Lipton's Cititour text in the Culture Sauce slot. Audit step caught the byline mismatch (`misattributedFullText: true`) and excluded the review entirely. Operator only noticed when checking why a review was missing.
Fix: surface misattribution in submission log immediately ("Culture Sauce: text byline says Brian Scott Lipton, expected Thom Geier — review excluded from this build"). Don't silently skip.

**A #22 — Compute-time composite score, not stored (Session A).** ⏳ Open.
`data/shows.json` doesn't store `compositeScore` — computed at build time during Next.js prerender. So "what is Joe Turner's composite right now" requires either (a) reading deployed show page JSON, OR (b) running local engine.ts. No quick CLI.
Fix: `node scripts/compute-composite.js --show=<id>` reads reviews.json + shows.json, prints what composite would be. Use during opening night to predict live score before deploy.

**A #23 — Recovery procedure has no runbook (Session A).** ⏳ Open.
When fullText/scores get stripped, operator has to know to (a) walk git history of each file, (b) find commit with non-empty fullText, (c) PUT back via Contents API, (d) trigger rebuild, (e) verify. This was ad-hoc node scripts tonight. Will be ad-hoc again next time.
Fix: `scripts/admin/recover-stripped-reviews.js <show-id>` — finds files where fullText went non-empty → empty in last N hours, restores from history, marks `_locked`. Document in runbook.

---

## ❌ OPEN — P2 (lower priority but logged)

**A #10 — No URL-fragment normalization on dedup (Session A).** Same Culture Sauce review existed twice — once with `#google_vignette` anchor, once without — created two separate files. Manual merge required. Fix: normalize URLs (strip `#fragment`, normalize protocol+host) before comparing for dedup.

**A #11 — No dry-run mode on admin ingest UI (Session A).** Cannot preview detection results without committing a real file. The "Detected" preview helps but commit still happens on submit. Fix: add `?preview=1` flag or "Preview only" checkbox.

**A #12 — Failed batch entries clear from textarea (Session A).** When batch had partial failures, textarea was empty after submit — operator lost the failed entries. Fix: on partial-failure, repopulate textarea with ONLY failed entries (with their error inline), keep successful entries cleared.

**A #13 — REVIEW_TEXTS_TOKEN in Vercel prod is a personal gh OAuth (gho_) (Session A).** If gh CLI auth on Tom's machine is revoked, the admin form breaks. Fix: dedicated fine-grained PAT scoped to broadway-review-texts:contents-write + Broadwayscore:actions-write. Replace in Vercel.

**A #14 — Per-run concurrency means N parallel rebuilds for N batch submits (Session A).** Already fixed in batch mode (commit-all + dispatch-once via `/api/admin/dispatch-rebuild`). But single-mode submits still each fire a rebuild. With 10 single submits in 5 min, 10 parallel rebuilds. Fix: server-side cooldown on dispatch — if one fired in last 30s, skip dispatch and rely on the in-flight one to pick up.

**A #15 — Disabling pollers leaves files unprotected from rebuild push step (Session A).** During the incident, even with pollers disabled, the rebuild's own push-back was stripping fullText. Re-enabling pollers safely required adding `_locked: true` to all files first. Fix: same as #A2 — protectedFields enforcement at push step (now patched 6c34f1ebf7 for empty-string case).

**A #24 — NYT text extraction was incomplete (Session A).** Helen Shaw recovery via Bright Data + cleanup heuristic ("By Helen Shaw" to "Helen Shaw is the chief theater critic") yielded only 3594ch. Full review likely 5000-7000ch. The slice grabbed too narrow a window. LLM scored from this partial text and got 75; with full text might have been 78-82. Fix: use existing collect-review-texts.js logic (proper article-body extraction with Readability or similar) instead of regex slice in admin recovery scripts.

**A #25 — Critics_Pick scoring may be too conservative (Session A).** Floor 70 + bump +3 = a Critics' Pick effective floor of 73 (or actual score whichever higher). For NYT — most prestigious Critics' Pick designation — this still allows scores like 78. Most NYT Critics' Picks should probably be 85+. Fix: (a) raise NYT-specific floor to 80, OR (b) increase bump for nytimes-Critics_Pick to +8 to +10. Validate against historical NYT Critics' Pick reviews.

**A #26 — No URL-vs-text consistency check on user paste (Session A).** When user pastes wrong text into a slot (Cititour text under Culture Sauce), system catches it AFTER commit (audit-wrong-production) — only because of byline mismatch. If two reviews shared same byline, system would silently accept wrong text. Fix: detect step should fetch a small snippet of the URL's actual content and verify pasted text overlaps significantly. 50%+ word overlap on first 1000 chars = match.

**A #27 — Field-naming inconsistency for pull-quote (Session A).** Stored as `llmPullQuote` in source files, `pullQuote` in reviews.json, `q` in compact show JSON. Three names for same concept. Fix: standardize on one name. Document compact-vs-full schema mapping in `memory/data-shapes.md` (new file).

**A #28 — Pollers don't know when a show is "complete" (Session A).** Even after 17 of 17 BWW RR critics + Theatermania were ingested, opening-night-poller kept running its discovery + collection cycle every few minutes. Wasted CI compute + risks more strip incidents. Fix: pollers should check reviews.json against expected critic list. When 90%+ coverage reached, drop polling cadence to hourly. When 100%, stop until next opening-night cron picks up new candidates.

**A #29 — `humanReviewScoreProvisional` flag semantics (Session A).** Set to `false` by `buildManualReviewFields()` to mark user-supplied scores as authoritative. But many recovered files don't carry this flag — score may be re-treated as provisional by re-scoring later. Fix: recovery scripts should set `humanReviewScoreProvisional: false` whenever they write a humanReviewScore from history. Add to protectedFields list.

**A #30 — Score-source attribution opaque (Session A).** `deadline/greg-evans.json` has `humanReviewScore: 85` AND `source: outlet-serp-discovery`. The score came from user but file's `source` shows original auto-discovery origin. No way to see "this score came from user via admin UI" vs "this came from LLM scoring". Hard to audit. Fix: add `humanReviewScoreSource: 'admin-ingest-ui' | 'manual-cli' | 'recovered-from-history'` field. Don't conflate with file's overall `source`.

---

## Outcome metrics

**Joe Turner — final live state:**
- 17 BWW RR critics + Theatermania = **18 distinct critic reviews** ingested (per Session B's count: 16 review files + 12 from manual admin-ingest UI as the workhorse path; per Session A's deeper audit: 17 in reviews.json initially, then 18 after Culture Sauce recovered)
- Composite score: ~77-78 (tier-weighted)
- All 17 in-reviews.json have pull-quotes after final rebuild + extract-pull-quotes
- LLM ensemble scored everything with text. Helen Shaw NYT scored 75 (Positive) + Critics_Pick designation = 78 effective
- ScrapingBee credits: 26% remaining (only open health flag from pre-opening audit)

**Time impact:** ~2 hours of recovery + 10+ rebuild/deploy cycles. Show ended up correct but operator (Tom) lost confidence + spent significant attention on it.

---

## Files changed (all on main)

**Session B:**
- `scripts/watch-aggregator-urls.js` (new — BWW homepage matcher)
- `.github/workflows/aggregator-url-watcher.yml` (new)
- `.github/workflows/opening-night-poller.yml` (gate fix — any_action signal)
- `scripts/lib/poller-blocklist.js` + `scripts/block-review.js` (new — RHS #5)
- Cloudflare short-circuits in BWW scrape paths (RHS #4)

**Session A:**
- `src/lib/admin-ingest-detect.ts` (URL-slug priority — c741ee089f)
- `.github/actions/push-review-texts/action.yml` (empty-string + _locked protection — 6c34f1ebf7)
- (Plus the original Alt 2 admin ingest UI shipped earlier this week)

---

## Notion cards

- **Session B:** `34e637c5-416f-8159-902a-e784e9f2fc72` — "Aggregator URL fast watcher (BWW RR + DTLI)" — Done with full outcome notes.
- **Session A:** `34c637c5-416f-81c3-b2b5-f108cc43df0d` — "Ship Alt 2: admin ingest UI" — In progress; updated with this consolidated issue list.

---

## Recommended next-session work — priority order

(Combining both sessions' priorities)

1. **Show Score extractor (RHS #2 / Tonight #8)** — only opening-night-relevant scraper bug still actually unfixed. P0. Inspect current Show Score DOM, update `searchShowScore` / `extractShowScoreReviews` selectors in `scripts/gather-reviews.js`.

2. **Verify Tonight #4 fix in CI** — find a show with unscored existing reviews and dispatch the poller with no new URLs to confirm `any_action` fires score+rebuild+deploy. Local-only testing was the only verification before merge.

3. **Audit full rebuild's enrichment chain (A #18)** — biggest un-mitigated risk. Each enrichment script in `rebuild-reviews.yml` may strip `_locked` files with non-empty content. Patch each to honor `_locked` OR add a top-level guard.

4. **Fix the empty-write bug at the source (A #1, A #16)** — `collect-review-texts.js` and the poller must NEVER write `fullText: ''` over an existing non-empty value. Push-action patch (6c34f1ebf7) catches it at push time but stripping shouldn't happen in the first place.

5. **Concurrency coordination (Tonight #7, A #21)** — propose a watcher idempotency check + tighter poller concurrency group to avoid push storms when multiple writers race.

6. **Opening-night completeness alerting (A #19, A #20)** — automated check for missing critics + drop detection on fast rebuild.

7. **Verify cron is firing autonomously (Tonight #5)** — first cron tick still hadn't fired during session. If still silent after 24h, escalate or move to launchd.

8. **CI rebuild auto-rename (RHS #6)** — workaround works; real fix is the 95%-similarity rename logic in `rebuild-all-reviews.js`.

9. **Recovery runbook (A #23)** — ad-hoc tonight; productize as `scripts/admin/recover-stripped-reviews.js`.

10. **Cross-production validation (A #8)** + **NYT Critics_Pick auto-detect (A #9)** + **URL-vs-text consistency check (A #26)** — three related guards on admin ingest UI that would prevent a class of paste-error / wrong-production bugs.

11. **BWW reviews.php narrow anchor count (Tonight #6)** — secondary now; investigate selector.

---

## Total inventory

- **Session A:** 30 issues (#A1–A30)
- **Session B:** 14 issues (RHS #1–6 + Tonight #1–8)
- **Overlap:** push contention / concurrency between A #7/#21 and Tonight #7
- **Distinct:** ~42 issues across both

What worked well:
- Per-run concurrency groups on rebuild + deploy meant nothing got queue-cancelled
- Recovery-from-git-history approach worked (data was always in commits, just not at HEAD)
- Cancelling pollers immediately stopped bleeding when bug identified
- LLM ensemble scoring is reliable when given full text
- Critics' Pick floor + bump applied correctly when designation set
- The two parallel sessions caught complementary bug classes — A focused on the user's manual ingest path, B on the automated discovery + rebuild paths
