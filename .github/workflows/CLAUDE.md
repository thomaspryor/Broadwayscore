# GitHub Actions Workflow Reference

Detailed descriptions of all automated workflows. See root `CLAUDE.md` for secrets table and critical rules.

## Failure Notifications

All new workflows MUST include the `notify-failure` composite action (`.github/actions/notify-failure/`). Add as the LAST step in the last job:
```yaml
      - name: Notify on failure
        if: failure()
        uses: ./.github/actions/notify-failure
        with:
          title: 'Workflow Name Failed'
          severity: 'warning'  # Only use 'critical' for the 5 listed in §Notification Severity
```
For critical workflows, add `email: 'true'` + `resend_api_key`/`owner_email` secrets. The `discord_webhook` input is accepted but ignored (kept for call-site compatibility — no need to pass it in new workflows). Currently 186/186 workflows have notifications. A CI guard in `test.yml` (`audit-workflow-hygiene.js`) enforces this for all new workflows. Exempt a workflow: add `# hygiene-notify-ok: <reason>` anywhere in the file.

## Playwright Setup

All workflows that use Playwright MUST use the shared composite action instead of inline `npx playwright install`:
```yaml
      - name: Setup Playwright
        uses: ./.github/actions/setup-playwright
```
This caches `~/.cache/ms-playwright` across runs (~15s saved per workflow). CI guard in `test.yml` enforces this; exempt with `# hygiene-playwright-ok: <reason>`. For non-chromium browsers:
```yaml
        with:
          browsers: 'chromium webkit'
```
Default is `chromium` only. Never use inline `npx playwright install` — the CI lint will eventually enforce this.

## Push Retry

All push-to-remote steps MUST use the shared script instead of inline retry loops:
```bash
bash scripts/lib/push-with-retry.sh [max_retries] [branch]
```
Defaults: 7 retries, main branch. Handles cleanup, rebase -X theirs, random backoff, `::error::` + `exit 1` on failure. CI guard in `test.yml` enforces this; exempt with `# hygiene-push-ok: <reason>` (external remotes, custom retry loops).

## Public Show JSON Safety

**Only `rebuild-all-reviews.js` may write complete `public/data/shows/*.json` files.** Any other script that needs to update a single field (images, audience data, metadata) MUST do a surgical merge: read the existing public JSON, update only the field it owns, write back. **Never regenerate public show JSONs from core-data** — the core-data checkout may be stale, and regeneration wipes reviews added by concurrent sessions.

```js
// GOOD: surgical update of one field
const show = JSON.parse(fs.readFileSync(publicPath));
show.hi = newImagePath;
fs.writeFileSync(publicPath, JSON.stringify(show));

// BAD: full regeneration (wipes reviews if core-data is stale)
const show = buildPublicShowJson(coreDataShow, coreDataReviews);
fs.writeFileSync(publicPath, JSON.stringify(show));
```

**Lesson:** An image-path rebuild regenerated 837 public JSONs from a stale reviews.json, wiping all reviews for recently-scored shows (March 20, 2026).

## Staging Data Files

**NEVER commit `data/aggregator-archive/` or `data/review-texts/` to the public repo.** These contain copyrighted content. They live in private repos and are synced via `push-review-texts` / `push-core-data` actions.

When staging data changes in workflows, use the shared helper:
```bash
bash scripts/lib/stage-data-changes.sh              # stages data/ with exclusions
bash scripts/lib/stage-data-changes.sh data/ public/ # stages specific paths with exclusions
```
This automatically excludes `data/aggregator-archive/` and `data/review-texts/`. **NEVER use `git add -f data/aggregator-archive/`** — this overrides `.gitignore` and leaks copyrighted files. A CI guard ("Guard — no copyrighted content in public repo" in `test.yml`) catches violations, but fix the workflow rather than repeatedly untracking files.

## Notification Severity

Only 4 workflows should use `severity: 'critical'`: `vercel-deploy`, `opening-night-broadcast`, `opening-night-poller`, `data-health-check` (carries the email digest — if it crashes, daily email won't send). These get real-time email alerts (via Resend) with a 2-hour cooldown per workflow. `check-cron-health` was downgraded to `warning` (2026-05-17) — cron staleness and cookie health both surface in BSC Daily. **Important:** `.github/actions/notify-failure/action.yml` is a no-op for any severity other than `critical` — do not rely on invoking it with `warning`/`low` to send anything. Non-critical failures appear in the digest below.

All other workflows (including `send-follow-notifications`) use `'warning'` or `'low'`. Their failures surface in the **daily email digest** sent by `health-check.js` — specifically `getWorkflowRunSummary()` at `scripts/health-check.js:818` which queries the GitHub Actions API for every workflow run in the last 24 hours and renders a `Workflow Runs (24h)` section plus a `⚠️ Repeat Workflow Failures (24h)` section for any workflow that failed 2+ times (surfaces stuck-broken workflows before they rot for days). As of 2026-06-16 (Notion 381637c5) those repeat failures are also **promoted into the digest's check results** via `repeatFailureResults()`: each offending workflow becomes a `Workflow repeat-failure: <name>` check (`error` at 3+ failures, `warn` at exactly 2), routed to `fix-now` in the playbook, so it now drives the subject line, the unfixed-error count, consecutive-error escalation, and auto-triage — not just the passive body section. Real-time escalation for scheduled workflows with deterministic cadence lives in `check-cron-health.yml`'s `CRITICAL_CRONS` list — add entries there when a workflow's staleness is user-facing (pages a user can screenshot). **`test.yml` on push to main is a special case:** a 24h window with 2+ main test.yml failures now escalates via the promoted check above, but the digest is once-daily; check-cron-health still can't see it (it keys staleness off the last *successful* run, so interleaved greens reset the clock). The `test-summary` job's "Detect consecutive main test failures" step remains the real-time path — it pages the owner by email the moment main test.yml fails on 2+ consecutive pushes, firing once per streak. Added 2026-06-15 after main was red 11/19 push runs over 06-13→06-15 with no alert. **The digest carrier (`data-health-check.yml`) watches itself:** it's a `CRITICAL_CRONS` entry at a deliberately-tight 26h (not the generic daily 36h) so the noon-UTC check pages critical+email the same day the 7 UTC digest is *cancelled* (cancellation sends no digest and notify-failure ignores `conclusion=cancelled`). 36h would let the next day's success reset the clock before the next noon check, making a single cancel invisible. The 26h is exempt from the cushion warning in `audit-cron-health-coverage.js` (`TIGHT_BY_DESIGN`) — do not raise it. Added 2026-06-16 (Notion 381637c5-416f-81af) after 2/14 digest runs were silently cancelled.

## Actionlint

Structural workflow linting runs in `test.yml` (`lint-workflows` job). Shellcheck disabled (`-shellcheck=""`). `>10 inputs` rule suppressed (3 workflows legitimately exceed). Currently `continue-on-error: true` — remove after ~March 11 if stable.

---

## Data Sync Architecture

**Source of truth:** `data/review-texts/{show-id}/*.json` (individual review files in private repo `thomaspryor/broadway-review-texts`)
**Derived file:** `data/reviews.json` (aggregated for website consumption, in private repo `thomaspryor/broadway-scorecard-data`)

### Private Repo Pattern (core data)
9 core data files (`shows.json`, `reviews.json`, `grosses.json`, etc.) live in `thomaspryor/broadway-scorecard-data`. All workflows check them out via `.github/actions/checkout-core-data/` and push changes via `.github/actions/push-core-data/`. See root `CLAUDE.md` §7b for full details.

| Workflow | Modifies review-texts | Rebuilds reviews.json | Notes |
|----------|----------------------|----------------------|-------|
| `rebuild-reviews.yml` | ❌ | ✅ | **PRIMARY sync** - daily + manual trigger. LLM enrichment moved to `enrich-reviews.yml` 2026-04-30. |
| `enrich-reviews.yml` | ✅ | ❌ | LLM enrichment of review-text flags (isNonReview, wrongProduction, wrongShow, criticName backfill). Every 6h. |
| `review-refresh.yml` | ✅ | ✅ | Weekly extraction + rebuild |
| `gather-reviews.yml` | ✅ | ✅ | Parallel-safe, rebuilds inline, **dispatches deploy** |
| `collect-review-texts.yml` | ✅ | ✅ | Parallel-safe, rebuilds inline after commit |
| `fetch-guardian-reviews.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |
| `process-review-submission.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |
| `adjudicate-review-queue.yml` | ✅ | ❌ | Daily 5 AM UTC, triggers rebuild after commit |
| `scrape-nysr.yml` | ✅ | ❌ | Weekly NYSR via WordPress API, relies on daily rebuild |
| `scrape-new-aggregators.yml` | ✅ | ✅ | Weekly Playbill Verdict + NYC Theatre, rebuilds inline after scrape |
| `scrape-bww-reviews.yml` | ✅ | ✅ | Weekly BWW /reviews/ pages + roundups, rebuilds after scrape |
| `audit-aggregator-coverage.yml` | ❌ | ❌ | Weekly audit, writes `data/audit/aggregator-coverage.json` only |
| `close-coverage-gaps.yml` | ✅ | ✅ | Manual per-era gap closure orchestration (audit → parallel gather → scrape PV/NYC → rebuild) |
| `opening-night-broadcast.yml` | ✅ | ✅ | 2x daily, discovers reviews via SERP + aggregators, rebuilds, sends broadcast email |
| `scrape-dtli-show-score.yml` | ✅ | ✅ | Weekly DTLI + Show Score page fetching, extraction, rebuild |

**For bulk imports (100s of shows):** Run parallel gather-reviews, then trigger manual rebuild via:
```bash
gh workflow run "Rebuild Reviews Data" -f reason="Post bulk import sync"
```

---

## `rebuild-fast.yml`
- **Runs:** Every 4 hours at :45 UTC (`45 */4 * * *` — safety-net cron) + manual trigger
- **Does:** Lightweight rebuild: checkout → rebuild reviews.json → push → deploy. No backfill, classification, or flagging steps. ~5 min instead of ~30 min.
- **Concurrency:** Per-run group (`rebuild-fast-${{ github.run_id }}`); parallel runs allowed.
- **Safety-net role (Notion 362637c5-416f-81ce):** Vercel's static export only re-renders /opera, /broadway, /off-broadway, /west-end when a deploy fires. If `llm-ensemble-score.yml`'s rebuild dispatch silently 403s on GitHub API rate limits, reviews land but pages stay frozen at the last-build snapshot. The 4-hourly cron + dispatch-retry in `llm-ensemble-score.yml` close that gap. Cron runs are byte-identical no-ops via the change-gate commit/deploy step when there's nothing to do.
- **When to use manually:** Opening-night corrections, manual data fixes, any time you need a fast rebuild without the full pipeline
- **Manual trigger:** `gh workflow run "Rebuild Reviews (Fast)" -f reason="your reason"`
- **Options:** `reason` (commit message; defaults to "Scheduled safety-net refresh" on cron), `force_write` (override regression guard)
- **Key difference from full rebuild:** Skips extract-pull-quotes, classify-non-reviews, flag-wrong-production, classify-wrong-production, classify-wrong-show, backfill-unknown-critics, cleanup-phantom-outlets, strip-stale-scores, detect-syndicated-duplicates, apply-audit-flags, analyze-rebuild-drops, audit-wrong-production, enrich-cast, generate-status-page. Keeps: rebuild, critic registry, mobile detail JSONs, deploy, **`check-opening-night-completeness.js`** (A #20 — strict per-show drop alert for shows in ±7d opening-night window).

## `enrich-reviews.yml`
- **Runs:** Every 6 hours at :30 (04:30, 10:30, 16:30, 22:30 UTC), or manually
- **Does:** Runs the 4 LLM/scraper enrichers that previously lived in `rebuild-reviews.yml`: `classify-non-reviews.js`, `classify-wrong-production.js`, `classify-wrong-show.js`, `backfill-unknown-critics.js --critics-only`. Pushes flag updates back to `data/review-texts/` private repo. Does NOT rebuild reviews.json or deploy — flag changes land in the next rebuild via `isIncludableForRebuild`.
- **Why decoupled (Notion 351637c5-416f-8177):** When these 4 steps lived inside `rebuild-reviews.yml`, their cumulative ~20-40min runtime made the rebuild job a cancellation magnet. Step 18 "Rebuild reviews.json" was getting skipped on most runs and reviews.json went stale for hours. Splitting moved the slow LLM work to its own concurrency group so cancellation can't block the canonical scored composite.
- **Concurrency:** `enrich-reviews-${{ github.run_id }}` (per-run, queued, never cancels — same pattern as rebuild-fast.yml)
- **Options (all default false):** `skip_classify_non_reviews`, `skip_classify_wrong_production`, `skip_classify_wrong_show`, `skip_backfill_critics`
- **Manual trigger:** `gh workflow run "Enrich Reviews"`
- **Requires:** `GEMINI_API_KEY` (3 of 4 steps), `BRIGHTDATA_TOKEN`+`BRIGHTDATA_ZONE`+`SCRAPINGBEE_API_KEY` (backfill-unknown-critics), `REVIEW_TEXTS_TOKEN` (push)
- **All steps `continue-on-error: true`** — partial failure does not stop later enrichers, and the `if: always()` push step at the end commits whatever flags landed.

## `rebuild-reviews.yml`
- **Runs:** Daily at 4 AM UTC (11 PM EST), auto-triggered via `workflow_run` when "Collect Review Texts" completes successfully, or manually triggered
- **Does:** Rebuilds `reviews.json` from `review-texts/` source files. Pre-rebuild utilities: `flag-wrong-production-by-date`, `audit-pre2005-reviews`, `backfill-unknown-outlets` (local), `cleanup-phantom-outlets`, `strip-stale-single-model-scores`, `detect-syndicated-duplicates`, `apply-audit-flags`. LLM enrichment (4 steps) MOVED to `enrich-reviews.yml` 2026-04-30.
- **Manual trigger:** `gh workflow run "Rebuild Reviews Data" -f reason="Post bulk import sync"`
- **Purpose:** PRIMARY sync mechanism for derived data
- **Concurrency:** `rebuild-reviews` group (queued, not cancelled)
- **When to use manually:**
  - After bulk imports (100s of shows via parallel gather-reviews)
  - After manual edits to review-texts files
  - When reviews.json appears stale
- **Script:** `scripts/rebuild-all-reviews.js`
- **Auto-scoring:** After rebuild, auto-triggers `llm-ensemble-score.yml` if 5+ reviews need scoring (threshold lowered from 100 on Feb 25, 2026)
- **Drop analysis:** After rebuild, runs `scripts/analyze-rebuild-drops.js` (`continue-on-error: true`). Fires if total dropped >30 OR any single show >10. Calls Claude Sonnet to classify drops as flag-explained (routine dedup/quality work) vs unexplained. Sends email with ROUTINE/NEEDS_REVIEW/SUSPICIOUS verdict. 48h cooldown. All guards in `rebuild-all-reviews.js` are **non-blocking** — they write audit files to `data/audit/rebuild-score-drift.json` (Guard 3B), `data/audit/rebuild-regression.json` (Guard 3B-ii), and `data/audit/rebuild-show-drift.json` (Guard 3B-iii) but never call `process.exit(1)`. The `ALLOW_DRIFT` env var has been removed from all workflows.
- **Opening-night drop check:** After analyze-rebuild-drops, runs `scripts/check-opening-night-completeness.js` (`continue-on-error: true`). Stricter than analyze-rebuild-drops for shows in the ±7d opening-night window: any per-show drop OR per-critic disappearance fires a Discord alert (warning severity, 60-min per-show cooldown). Reads the same `data/audit/rebuild-regression.json` plus its own `data/audit/opening-night-completeness-state.json` snapshot. See A #19 / A #20 in `memory/feedback_admin_ingest_opening_night_2026-04-26.md`.

## `update-show-status.yml`
- **Runs:** Daily at 8 AM UTC (3 AM EST)
- **Does:** Updates show statuses (open → closed, previews → open), discovers new shows on Broadway.org, auto-adds new shows with status "previews"
- **IBDB enrichment:** New shows are enriched with preview/opening/closing dates from IBDB. If IBDB fails, Broadway.org's "Begins:" date is treated as `previewsStartDate` (not `openingDate`)
- **Metadata enrichment (after discovery):** Enriches newly discovered shows with TodayTix runtimes/intermissions/age (`enrich-todaytix-runtimes.js`), Wikipedia synopses (`enrich-wikipedia-synopsis.js --limit=20`), and Wikipedia runtimes (`enrich-wikipedia-runtimes.js --limit=20`). All `continue-on-error: true`. Added Feb 23, 2026.
- **Timeout:** 10 minutes (to accommodate IBDB lookups with rate limiting)
- **Triggers for newly opened shows (previews → open):** `gather-reviews.yml`, `update-reddit-sentiment.yml`, `update-show-score.yml`, `update-mezzanine.yml`, `fetch-all-image-formats.yml`, `opening-night-poller.yml`, `opening-night-broadcast.yml`
- **Outputs:** `opened_count`, `opened_slugs` (shows transitioning previews→open), plus discovery outputs
- **Note:** Discord notification for new shows removed Feb 20, 2026 (noise reduction)

## `opening-night-checklist.yml`
- **Runs:** Hourly at :17 (`17 * * * *`), or manually via `workflow_dispatch`
- **Does:** Runs 6 automated opening-night QA checks for shows opening within ±2 days, evaluates stage-latency SLA, dispatches Discord/email alerts for breaches. Commits `data/audit/opening-night-history.json` + `data/audit/opening-night-latency-YYYY-MM-DD.json`.
- **SLA thresholds:** 30-min in-flight review → Discord warning; 60-min → P0 page (Discord + email to owner)
- **Severity:** `warning` (non-critical — failures surface in daily digest, not real-time alert)
- **CRITICAL_CRONS:** registered with 3h max gap in `check-cron-health.yml`
- **Options:** `show_id` (target specific show), `dry_run` (evaluate SLA, skip Discord/email dispatch)
- **Scripts:** `scripts/opening-night-checklist.js`, `scripts/opening-night-latency-report.js`, `scripts/opening-night-sla-dispatch.js`
- **Requires:** `DISCORD_WEBHOOK_ALERTS`, `RESEND_API_KEY`, `OWNER_EMAIL`, `REVIEW_TEXTS_TOKEN`
- **Manual trigger:** `gh workflow run opening-night-checklist.yml -f show_id=the-rocky-horror-show-2026 -f dry_run=true`
- **Related:** `opening-night-orchestrator.yml` also calls the checklist once after its polling loop; `opening-night-broadcast.yml` gates sends on checklist passing (override with `force_broadcast=true`)

## `opening-night-completeness-check.yml`
- **Runs:** Every 15 min (`*/15 * * * *`), or manually via `workflow_dispatch`
- **Does:** Fast snapshot-diff drop detector for shows in the ±7d opening-night window. No aggregator fetches — just reads `data/reviews.json`, builds the per-show `(outletId, criticName)` set, and diffs against `data/audit/opening-night-completeness-state.json` from the previous run. Any disappearance, score-source loss, or count regression fires a single Discord alert summarizing all affected shows.
- **Why it exists (A #19/#A20):** Joe Turner's Come and Gone went 14 → 12 → 14 → 17 reviews silently across opening night because `analyze-rebuild-drops.js` only runs in the full rebuild and was below its 30-total / 10-single-show thresholds. Operator noticed Culture Sauce was missing from the live page only by manual eyeball. This workflow + the new step in rebuild-fast/rebuild-reviews catches per-critic drops at every cadence (rebuild + 15-min cron).
- **Skips when rebuild is in flight:** Avoids racing with `rebuild-reviews.yml` / `rebuild-fast.yml` (those workflows run the same script as a post-rebuild step).
- **Cooldown:** 60 min per show — prevents storm during a rebuild-loop opening night.
- **Severity:** `warning` (Discord alert via `scripts/lib/discord-notify.js`; failures surface in the daily digest).
- **State file:** `data/audit/opening-night-completeness-state.json` — committed back via `push-with-retry.sh` so consecutive runs share snapshot.
- **Options:** `show_id` (single-show), `window_days` (default 7), `force` (bypass cooldown).
- **Manual trigger:** `gh workflow run "Opening Night Completeness Check" -f show_id=joe-turners-come-and-gone-2026 -f force=true`
- **Script:** `scripts/check-opening-night-completeness.js`
- **Requires:** `DISCORD_WEBHOOK_ALERTS`, `REVIEW_TEXTS_TOKEN` (for checkout-core-data)

## `opening-night-reviews.yml`
- **Runs:** Daily at 5 AM UTC (midnight EST), or manually
- **Does:** Finds shows that opened in the last 2 days (by `openingDate`), triggers `gather-reviews.yml` to catch opening night reviews the same evening they're published
- **Why:** The morning `update-show-status.yml` (8 AM UTC) fires before reviews exist (~10-11 PM EST). This evening workflow catches reviews after publication.
- **Options:** `lookback_days` (default 2)
- **Guards:** Checks if gather-reviews is already running before triggering
- **No secrets needed** beyond `GITHUB_TOKEN`
- **Manual trigger:** `gh workflow run "Opening Night Reviews" -f lookback_days=7`

## `opening-night-broadcast.yml`
- **Runs:** Daily cron at 12:30 UTC (8:30 AM EDT / 7:30 AM EST) with `send_to_all=true` semantics — creates Resend draft AND emails owner a preview. Also dispatched by: (1) `update-show-status.yml` when a show opens (preview only), (2) `workflow_run` after `LLM Ensemble Score Reviews` completes (preview only, auto-retry), (3) manual `workflow_dispatch`
- **Does:** Thin "check & send" workflow — reads existing scored data, generates consensus, sends broadcast email. Heavy lifting (gather, rebuild, score) handled by independent data pipeline.
- **Pipeline:** Find recently opened BW+WE shows → check already broadcast → sync subscribers (Formspree) → generate consensus → send broadcast → commit → deploy → indexing
- **Data dependency:** Relies on data pipeline chain: `update-show-status` → `gather-reviews` → `rebuild` → `llm-ensemble-score`. The 5 AM run catches shows scored overnight; 8 AM catches shows scored between 5-8 AM.
- **Early exit:** No recent openers or all already broadcast → exits in <10s (no Node setup)
- **Readiness gate:** 8+ scored reviews required before sending (in `send-opening-night-broadcast.js`)
- **Checklist gate (added 2026-04-17):** Before sending, runs `opening-night-checklist.js --show=ID --json` for each pending show. If any show has checklist errors, blocks broadcast and sends Discord warning + email to owner. Override with `force_broadcast=true` input (emergency use only).
- **Market filter:** Only Broadway and West End shows trigger emails. OB shows get website data via pipeline but no broadcast.
- **Budget gate:** Cap at 60 sends/market (Broadway) and 35 sends/market (West End) per run
- **Multi-show coalescing:** If 2+ shows open same night in a market, sends single email with multiple score cards
- **Resume:** Tracks `sentCount` in `data/opening-night-sent.json` (gitignored but `git add --force` in commit step). If interrupted, next cron run picks up where it left off.
- **Double-send prevention (3 layers as of PR #233, 2026-04-11):**
  1. `completed: true` flag per show in `opening-night-sent.json` short-circuits both the "Check already broadcast" workflow step and the script's pendingShows filter.
  2. Rolling-window dedup via `scripts/lib/preview-dedup.js`: `checkPreviewDedup` (script-side, 24h + 3-new-review exception) and `hasRecentPreviewForShow` (workflow-side "Check already broadcast" step, 24h). Replaced the old UTC-day key that failed at UTC rollover (2026-04-11 incident). Overdue alerts use `hasRecentOverdueAlert`.
  3. Cross-session advisory lock via `scripts/lib/send-lock.js`. All 3 audience-facing email paths (Resend preview `--send-to`, Buttondown draft creation, Resend owner notification) acquire a sha-CAS'd lock at `data/email-send.lock` before the network call and release on success + failure. Workflow's broadcast step MUST have `GH_TOKEN: ${{ github.token }}` in env or the lock helper exits(1) and blocks the send (fail-safe).
  4. `opening-night-sent.json` is force-added to git (`git add --force`) to persist across cron runs despite being gitignored. CLI preview runs additionally sync it to origin/main via `gh api contents PUT` through `syncTrackerToOrigin()`.
- **Preview vs approval mode:**
  - `workflow_dispatch` with `send_to=<email>`: single transactional preview to that address only (no draft).
  - `workflow_dispatch` with `send_to_all=true` OR the 12:30 UTC scheduled run: preview to owner AND creates a Resend draft for owner to click Send in Resend UI. Bypasses preview dedup so the draft can still fire even if an earlier preview went out.
  - All other triggers (`update-show-status`, `workflow_run` from scoring, default `workflow_dispatch`): preview to owner only, subject to 24h rolling preview dedup.
- **Scripts:** `scripts/send-opening-night-broadcast.js`, `scripts/generate-critic-consensus.js`
- **Requires:** ANTHROPIC_API_KEY, RESEND_API_KEY, FORMSPREE_FOLLOW_API_KEY, FORMSPREE_SUBSCRIBER_API_KEY, FORMSPREE_FOLLOW_FORM_ID, FORMSPREE_SUBSCRIBER_FORM_ID, FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID, FORMSPREE_WESTEND_SUBSCRIBER_API_KEY
- **Manual trigger:** `gh workflow run "Opening Night Broadcast" -f lookback_days=7`
- **Related:** `opening-night-reviews.yml` handles SERP discovery + triggers gather-reviews (runs at 5 AM UTC). The data pipeline runs independently and feeds scored data to this broadcast workflow.

## `gather-reviews.yml`
- **Runs:** When new shows discovered (or manually triggered)
- **Does:** Gathers review data by searching aggregators and outlets, then scrapes supplementary aggregators (Playbill Verdict + NYC Theatre), then rebuilds `reviews.json`
- **Secrets required:** `ANTHROPIC_API_KEY`, `BRIGHTDATA_TOKEN`, `SCRAPINGBEE_API_KEY`
- **Script:** `scripts/gather-reviews.js`
- **Manual trigger:** `gh workflow run gather-reviews.yml -f shows=show-id-here`
- **Job pipeline:** `prepare → gather-reviews → scrape-aggregators (non-blocking) → rebuild → deploy`
  - `scrape-aggregators`: Runs Playbill Verdict + NYC Theatre for the target shows (`--shows=`). Uses `continue-on-error: true` so rebuild always runs even if scrapers fail. 30-minute timeout.
  - `rebuild` job: rebuilds reviews.json, pushes to both private repos, **dispatches Deploy to Vercel** (15-min dedup), then auto-triggers text collection if >20 reviews need it, and **auto-triggers LLM scoring** if any unscored reviews exist for the gathered shows.
- **Technical notes:**
  - Installs Playwright Chromium for Show Score carousel scraping
  - Show Score extraction uses Playwright to scroll through ALL critic reviews (not just first 8)
  - Detects and rejects Show Score redirects to off-broadway shows
  - Tries `-broadway` URL suffix patterns first
  - **Parallel-safe:** Only commits `review-texts/` and `archives/` (NOT `reviews.json`)
  - Uses retry loop (5 attempts) with random backoff for git push conflicts

## `review-refresh.yml`
- **Runs:** Weekly on Mondays at 9 AM UTC
- **Does:** Checks all open shows for new reviews, extracts from aggregator archives, **rebuilds reviews.json**, triggers collection if needed
- **Script:** `scripts/check-show-freshness.js`
- **Key steps:** Extract reviews → Rebuild reviews.json → Commit → Trigger collection for shows with gaps
- **Note:** Now automatically rebuilds `reviews.json` after extraction (fixed Jan 2026)

## `fetch-aggregator-pages.yml`
- **Runs:** Manual trigger only
- **Does:** Fetches and archives HTML pages from all three aggregator sources (Show Score, DTLI, BWW Review Roundups)
- **Manual trigger:**
  ```bash
  gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=missing
  ```
- **Options:** `aggregator` (show-score/dtli/bww-rr/all), `shows` (comma-separated IDs/"all"/"missing"), `force`
- **Archives saved to:** `data/aggregator-archive/{show-score,dtli,bww-roundups}/`

## `fetch-all-image-formats.yml`
- **Runs:** Twice weekly (Mon & Thu at 6 AM UTC), or triggered by show discovery
- **Does:** Fetches poster/thumbnail/hero images, archives locally as WebP, updates `shows.json` to use local paths
- **Image sourcing (3-tier fallback):**
  1. **TodayTix API** (open shows) — batch-fetches all active NYC shows from `api.todaytix.com/api/v2/shows`, uses native `posterImageSquare` (1080x1080), `posterImage` (480x720), `appHeroImage`. No ScrapingBee needed.
  2. **TodayTix page scrape** (closed shows) — discovers TodayTix page via Google SERP, scrapes Contentful image URLs, crops portrait to square via Contentful transforms
  3. **Playbill fallback** — OG image only (landscape, used as hero)
- **Scripts:** `scripts/fetch-show-images-auto.js` → `scripts/archive-show-images.js`
- **Triggered by:** `update-show-status.yml` and `discover-historical-shows.yml`
- **Image formats:** Poster 720x1080 (portrait), Thumbnail 1080x1080 (square), Hero 1920x800 (landscape) — all WebP
- **Flags:** `--missing` (only shows without images), `--bad-images` (re-source shows with identical Playbill images), `--show=ID` (single show)

## `weekly-grosses.yml`
- **Runs:** Every Tuesday & Wednesday at 3pm UTC (10am ET)
- **Does:** Scrapes BroadwayWorld for weekly box office and all-time stats, enriches with WoW/YoY from `grosses-history.json`
- **Data source:** BroadwayWorld (grosses.cfm, grossescumulative.cfm)
- **Skips:** If current week data already exists (unless force=true)

## `backfill-grosses.yml`
- **Runs:** Manual trigger only
- **Does:** Scrapes Playbill for historical weekly grosses to populate `grosses-history.json`
- **Options:** `weeks` (default 55), `start_from` (YYYY-MM-DD)
- **Reliability:** Uses `domcontentloaded` (not `networkidle`), 3 retries per week
- **Script:** `scripts/backfill-grosses-history.ts`
- **Note:** Only for initial setup or extending history range

## `backfill-aggregators.yml`
- **Runs:** Manual trigger only
- **Does:** One-time parallel backfill of Playbill Verdict + NYC Theatre data for all shows (730+)
- **Options:** `parallel_jobs` (default 5, 1-10), `aggregator` (all/playbill-verdict/nyc-theatre), `date_filter` (default false = all eras)
- **Job pipeline:** `prepare → backfill (N parallel matrix jobs) → rebuild`
- **Parallel-safe:** 30s stagger between jobs, 5-retry push with random backoff
- **Caching:** Both scripts skip shows with existing archives in `data/aggregator-archive/`. Re-runs cost ~0 API calls.
- **Cost:** ~$8-11 ScrapingBee credits for full 730-show backfill (first run)
- **Manual trigger:** `gh workflow run "Backfill Aggregator Data" -f parallel_jobs=5 -f aggregator=all`

## `bulk-collect-review-texts.yml`
- **Runs:** Manual trigger only
- **Does:** One-time bulk collection of review full texts across all shows, partitioned across parallel runners
- **Options:** `parallel_jobs` (default 5, 1-10), `max_per_job` (0 = all), `batch_size` (default 10), `browserbase_enabled` (default true), `browserbase_per_job` (default 5), `retry_failed` (default true), `archive_first` (default true), `content_tier` (filter), `aggressive` (default true, skips Playwright for known-blocked sites), `test_mode` (limit to 5/job), `max_rounds` (default 3, auto-chaining), `current_round` (auto-set)
- **Job pipeline:** `prepare → collect (N parallel matrix jobs) → rebuild → chain next round`
- **Self-chaining:** After rebuild, counts remaining reviews. If >50 remain and rounds left, auto-dispatches next round. Set `max_rounds=0` to disable. Stops at diminishing returns (<50 remaining).
- **Parallel-safe:** 45s stagger between jobs, SHOW_FILTER ensures disjoint show sets, 5-retry push with shows.json integrity check
- **Load balancing:** Prepare job counts reviews per show, sorts by count descending, distributes round-robin
- **Script:** `scripts/collect-review-texts.js` (with SHOW_FILTER env var for partitioning)
- **Requires:** `SCRAPINGBEE_API_KEY`, `BRIGHTDATA_TOKEN`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, plus login credentials (NYT, Vulture, WSJ, WaPo)
- **Cost:** ~$22-38 ScrapingBee + Browserbase credits per round
- **Manual trigger:** `gh workflow run "Bulk Collect Review Texts" -f parallel_jobs=5`
- **Full autonomous run:** `gh workflow run "Bulk Collect Review Texts" -f parallel_jobs=5 -f max_rounds=5` (chains up to 5 rounds)
- **Test mode:** `gh workflow run "Bulk Collect Review Texts" -f parallel_jobs=2 -f test_mode=true`

## `discover-historical-shows.yml`
- **Runs:** Manual trigger only
- **Does:** Discovers closed Broadway shows from past seasons, adds with status "closed" and tag "historical", auto-triggers review gathering
- **IBDB enrichment:** Enriches preview/opening/closing dates from IBDB after discovery
- **Usage:** Specify seasons like `2024-2025,2023-2024` (one or two at a time)

## `enrich-ibdb-dates.yml`
- **Runs:** Weekly on Wednesdays at 7 AM UTC (scheduled), or manually
- **Does:** Enriches or verifies show dates (preview, opening, closing) from IBDB. Scheduled runs target open shows only (skips 700+ closed).
- **Options:** `mode` (enrich/verify/force), `show` (optional slug), `status` (optional filter)
- **Script:** `scripts/enrich-ibdb-dates.js`
- **Requires:** `SCRAPINGBEE_API_KEY` (primary), `BRIGHTDATA_TOKEN` (fallback)
- **Modes:**
  - `enrich` (default): Fill missing/null dates only, never overwrite existing
  - `verify`: Compare IBDB vs shows.json, report discrepancies (read-only)
  - `force`: Overwrite all dates with IBDB values
- **Rate limiting:** 1.5s between IBDB requests, 30-minute timeout

## `process-review-formspree.yml`
- **Runs:** Daily at 6 AM UTC (1 AM EST), or manually
- **Does:** Polls Formspree review submission form, creates GitHub Issues for each new submission in the format `process-review-submission.yml` expects. Tracks processed IDs to prevent duplicates.
- **User-facing page:** `/submit-review` (Formspree form)
- **Script:** `scripts/process-review-formspree.js`
- **Tracking:** `data/audit/processed-review-submissions.json`
- **Requires:** `FORMSPREE_TOKEN`, `GITHUB_TOKEN`
- **Flow:** Formspree form → this workflow creates Issue → `process-review-submission.yml` auto-triggers

## `process-review-submission.yml`
- **Runs:** When GitHub issue created/edited with `review-submission` label
- **Does:** Validates review submission via Claude API, scrapes and adds if approved, closes issue
- **Triggered by:** `process-review-formspree.yml` (creates issues with `review-submission` label)
- **Issue template:** `.github/ISSUE_TEMPLATE/missing-review.yml`
- **Script:** `scripts/validate-review-submission.js`

## `update-show-score.yml`
- **Runs:** Weekly (Sundays 12pm UTC), on previews → open transition, or manually
- **Does:** Scrapes show-score.com for audience scores, updates `data/audience-buzz.json`
- **Options:** `show`, `shows` (comma-separated), `limit` (default 50)
- **Technical:** Uses ScrapingBee with JS rendering, extracts from JSON-LD, 1-hour timeout with `if: always()` commit
- **Script:** `scripts/scrape-show-score-audience.js`

## `update-reddit-sentiment.yml`
- **Runs:** Monthly (1st of month at 10am UTC), on previews → open transition, or manually
- **Does:** Scrapes r/Broadway for discussions, uses Claude Sonnet for sentiment analysis, updates `data/audience-buzz.json`. Default: open shows only (use --all for closed).
- **Options:** `show`, `shows` (comma-separated), `limit` (default 50)
- **Technical:** Uses ScrapingBee with premium proxy, generic titles use Broadway-qualified searches, 2-hour timeout with `if: always()` commit
- **Script:** `scripts/scrape-reddit-sentiment.js`

## `update-mezzanine.yml`
- **Runs:** Weekly (Sundays 1pm UTC, after Show Score), on previews → open transition, or manually
- **Does:** Calls Mezzanine (theaterdiary.com) Parse API to fetch all Broadway production ratings, matches to shows.json, updates `data/audience-buzz.json`
- **Options:** `show`, `shows` (comma-separated or "missing"), `limit`, `dry_run`
- **Technical:** Direct Parse Server REST API calls, no web scraping needed. Fetches all productions with ratings, filters to NYC/Broadway, matches via normalized title + year. 15-minute timeout.
- **Script:** `scripts/scrape-mezzanine-audience.js`
- **Requires:** `MEZZANINE_APP_ID`, `MEZZANINE_SESSION_TOKEN`
- **Note:** Session token may expire. To refresh, intercept Mezzanine iOS app traffic via mitmproxy and update the `MEZZANINE_SESSION_TOKEN` GitHub Secret.

## `update-lottery-rush.yml`
- **Runs:** Weekly (Mondays 10 AM UTC / 5 AM EST), or manually
- **Does:** Scrapes BwayRush.com (ScrapingBee with JS rendering → HTML→markdown → regex parsing) and Playbill lottery/rush article (ScrapingBee → Claude Sonnet LLM extraction). Incrementally merges into `data/lottery-rush.json`, syncs tags in `data/shows.json`.
- **Script:** `scripts/scrape-lottery-rush.js`
- **Requires:** `SCRAPINGBEE_API_KEY`, `ANTHROPIC_API_KEY`
- **Optional:** `BRIGHTDATA_TOKEN` (fallback, currently zone not configured)
- **Safety features:**
  - Pre-write backup (keeps last 5)
  - Incremental merge (scrapers add/update, never delete)
  - Stability guard (aborts if >5 new or >3 removed show IDs)
  - Closed show + orphan cleanup (separate lifecycle step)
  - Per-source post-processing (catches LLM lottery vs rush misclassifications)
  - Post-merge cleanup (deduplicates cross-source entries, removes non-integer SRO prices)
- **CLI:** `--source=bwayrush|playbill`, `--dry-run`, `--verbose`
- **Manual trigger:** `gh workflow run "Update Lottery/Rush Data"`

## `adjudicate-review-queue.yml`
- **Runs:** Daily at 5 AM UTC (1 hour after rebuild generates queue), or manually
- **Does:** Auto-resolves flagged reviews where LLM scores disagree with aggregator thumbs using Claude Sonnet
- **Script:** `scripts/adjudicate-review-queue.js`
- **Requires:** ANTHROPIC_API_KEY
- **Manual trigger:** `gh workflow run "Adjudicate Review Queue"` (supports `dry_run` option)
- **Logic:**
  - Reads `data/audit/needs-human-review.json` (produced by `rebuild-all-reviews.js`)
  - Early exit if queue is empty (no Node setup, no API calls)
  - For each flagged review: loads source file, calls Claude Sonnet with full text + context
  - High/medium confidence → writes `humanReviewScore` to source file
  - Low confidence → increments `adjudicationAttempts`, skips
  - After 3 uncertain attempts → auto-accepts LLM original score (permanent queue removal)
  - API errors don't consume adjudication attempts (transient failures)
  - Commits changed files, triggers `Rebuild Reviews Data` workflow
- **Parallel-safe:** Only commits `review-texts/`, uses push retry loop

## `update-critic-consensus.yml`
- **Runs:** Every Sunday at 2 AM UTC, auto-triggered by rebuild (when scoring not needed), or manually
- **Does:** Generates "Critics' Take" editorial summaries (1-2 sentences, max 280 chars) via Claude Sonnet. Smart regeneration: only processes shows where data changed meaningfully.
- **Triggers for regeneration (any one):** 3+ new reviews, 3+ full-text upgrades, 2+ reviews removed, or 8+ pt mean score drift. Fingerprints (`reviewCount`, `fullTextCount`, `meanScore`) tracked per show.
- **Options:** `force` (regenerate all), `max_shows` (default 200, cost control)
- **Concurrency:** `update-critic-consensus` group (queued, not cancelled)
- **Script:** `scripts/generate-critic-consensus.js` (`--show=X` for single-show, `--max-shows=N` cap, `--force`, `--cleanup-orphans`)
- **Data:** `data/critic-consensus.json` (gitignored, synced via push-core-data to private repo)
- **Requires:** ANTHROPIC_API_KEY, REVIEW_TEXTS_TOKEN
- **Chain:** scoring → rebuild → consensus (rebuild dispatches consensus when scoring doesn't fire)

## `process-feedback.yml`
- **Runs:** Every Monday at 9 AM UTC
- **Does:** Fetches Formspree submissions, AI-categorizes feedback, auto-diagnoses bugs/content errors, creates GitHub issue digest + separate bug-diagnosis issues
- **User-facing page:** `/feedback`
- **Scripts:** `scripts/process-feedback.js`, `scripts/diagnose-feedback-bug.js`
- **Requires:** FORMSPREE_TOKEN, ANTHROPIC_API_KEY
- **Bug diagnosis:** For each Bug/Content Error submission (max 5), keyword-matches to relevant file categories, loads code/data within ~30K token budget, calls Claude Sonnet for structured diagnosis. Creates separate GitHub Issue per bug with labels `bug-diagnosis` + `{priority}-priority`.
- **Cost:** ~$0.15/bug diagnosis, typical week $0-0.45, max $0.75
- **CLI test:** `node scripts/diagnose-feedback-bug.js --message "score seems wrong" --show "Hamilton"`

## `auto-fix-feedback-bug.yml`
- **Runs:** Automatically when a GitHub issue is created with the `bug-diagnosis` label (triggered by `process-feedback.yml`)
- **Does:** Auto-applies data-level fixes for high-confidence bug diagnoses. Parses structured diagnosis JSON embedded in the issue body, calls Claude Sonnet to generate exact field edits, applies them with safety rails, validates, commits, and closes the issue.
- **Script:** `scripts/auto-fix-feedback-bug.js`
- **Requires:** ANTHROPIC_API_KEY
- **Concurrency:** Serialized (queued, not cancelled) to prevent parallel data file conflicts
- **Auto-fix criteria:** `fixType=data` + `confidence=high` + resolved show ID
- **Allowed fields:** `shows.json` (venue, synopsis, runtime, intermissions, ageRecommendation, type, isRevival), `commercial.json` (designation, capitalization, weeklyRunningCost, capitalizationSource, notes), `audience-buzz.json` (title)
- **Protected fields:** id, slug, status, openingDate, closingDate, previewsStartDate, images, tags, cast, creativeTeam, recouped, deepResearch
- **Safety:** oldValue verification prevents stale-data writes, validate-data.js post-check with git rollback on failure
- **Outcomes:** `fixed` (closes issue), `not-a-bug` (labels, leaves open), `skipped` (labels needs-manual-review), `error`/`validation-failed` (labels needs-manual-review)
- **Cost:** ~$0.01-0.03 per fix attempt (one Claude Sonnet call)

## `update-commercial.yml`
- **Runs:** Every Wednesday at 4 PM UTC
- **Does:** Scrapes Reddit grosses analysis posts, searches trade press, optional SEC EDGAR filings, uses Claude Sonnet to propose commercial.json updates, multi-source validation, shadow classifier
- **Options:** `dry_run`, `gather_only`
- **CLI flags:** `--gather-sec`, `--gather-trade-full`, `--skip-validation`, `--gather-reddit`, `--gather-trade`, `--gather-all`
- **Script:** `scripts/update-commercial-data.js`
- **Supporting modules:** `scripts/lib/parse-grosses.js`, `scripts/lib/trade-press-scraper.js`, `scripts/lib/sec-edgar-scraper.js`, `scripts/lib/source-validator.js`
- **Requires:** ANTHROPIC_API_KEY, SCRAPINGBEE_API_KEY
- **Optional:** NYT_EMAIL, NYTIMES_PASSWORD, VULTURE_EMAIL, VULTURE_PASSWORD
- **On failure:** Auto-creates GitHub issue

## `process-commercial-tip.yml`
- **Runs:** When GitHub issue created/edited with `commercial-tip` label
- **Does:** Validates user-submitted commercial data tips via Claude API, applies if valid
- **Issue template:** `.github/ISSUE_TEMPLATE/commercial-tip.yml`
- **Script:** `scripts/process-commercial-tip.js`

## `collect-review-texts.yml`
- **Runs:** 3x daily at 4:30 AM, 10 AM, 6 PM UTC (150/batch + 2 chains for scheduled runs) + manual trigger
- **Rebuild trigger:** Rebuild fires automatically via `workflow_run` when collection completes (no explicit dispatch needed)
- **Does:** Fetches full review text using multi-tier fallback: Archive.org → Playwright → Browserbase → ScrapingBee → Bright Data. Supports subscription logins for paywalled sites.
- **Manual trigger:** `gh workflow run "Collect Review Texts" --field show_filter=show-id`
- **Parallel runs:** YES - launch multiple with different show_filter values
- **Options:** `batch_size` (default 10), `max_reviews` (default 500), `show_filter` (REQUIRED for parallel runs), `stealth_proxy`, `browserbase_enabled` (default true), `browserbase_max_sessions` (default 10)
- **Browserbase tier (1.5):** Managed browser cloud with CAPTCHA solving. Costs ~$0.10/session. Enabled by default. Spending caps (raised 2026-05-17 from incorrect "30/day, $3/day" doc — empirical April 2026 max was 275/day on Joe Turner opening night): `BROWSERBASE_MAX_SESSIONS_PER_DAY` 250 (hard ceiling $25/day = $750/mo MAX), `_PER_RUN` 30, `_PER_DOMAIN` 10. Normal usage $5-9/day. Cap defaults live in `scripts/collect-review-texts.js` and the pure decision function in `scripts/lib/browserbase-caps.js`. Per-run override via `browserbase_max_sessions` input.
- **Script:** `scripts/collect-review-texts.js`
- **Truncation detection:** Checks for paywall text, "read more" prompts, proper punctuation, text length ratios, footer junk. Marks as `textQuality: "truncated"`.

## `llm-ensemble-score.yml`
- **Runs:** Daily at 5 AM UTC (1 AM EST, after rebuild at 4 AM), auto-triggered by rebuild if 5+ unscored reviews, or manually
- **Concurrency:** `scoring-reviews` group (queued, not cancelled — separate from rebuild to avoid blocking)
- **Does:** Scores reviews using 3-model ensemble (Claude Sonnet + GPT-4o + Gemini 2.0 Flash) with bucket-first approach
  - **Bucket-first scoring:** Models classify into bucket (Rave/Positive/Mixed/Negative/Pan) first, then score within range
  - **Voting logic:** Unanimous (all 3 agree) → Majority (2/3) → No consensus (uses median)
  - **Graceful degradation:** 3→2→1 model fallback if any model fails
  - **2-model mode:** If GEMINI_API_KEY not set, uses Claude + GPT-4o only
- **Options:** `show`, `limit`, `run_calibration` (default true), `run_validation`, `dry_run`, `needs_rescore`
- **Script:** `scripts/llm-scoring/index.ts`
- **Requires:** ANTHROPIC_API_KEY, OPENAI_API_KEY
- **Optional:** GEMINI_API_KEY (enables 3-model mode)
- **Pre-flight test:** `npx ts-node scripts/llm-scoring/test-ensemble.ts` (tests ensemble logic with all 3 models)
- **Ensemble calibration:** `npx ts-node scripts/llm-scoring/index.ts --ensemble-calibrate` (analyzes per-model performance)
- **Phase 4 — stuck-emergency retry:** Daily check after Phase 3 (stale-scores). Counts reviews flagged `ensembleData.singleModelEmergency=true` with `singleModelEmergencyRetryCount<1` (and otherwise scoreable). If 1-50 found, dispatches `--retry-emergency` mode. Most cases are transient Gemini outages — the retry succeeds with 2+ models, the flag clears naturally inside `ensemble.ts:261`. If retry still single-model, `singleModelEmergencyRetryCount=1` is written so the next cron skips. Cap >50 disables auto-retry and emits a `::warning::` (manual investigation required — likely a model API-key revocation). Manual trigger: `gh workflow run "LLM Ensemble Score Reviews" -f retry_emergency=true`.

## `scrape-nysr.yml`
- **Runs:** Weekly on Sundays at 10 AM UTC, or manually
- **Does:** Scrapes New York Stage Review via WordPress REST API, fetches full text + star ratings for all Broadway reviews
- **Script:** `scripts/scrape-nysr-reviews.js`
- **No secrets needed** (public WordPress API)
- **Technical:** Paginates `/wp-json/wp/v2/posts?categories=1`, extracts star ratings from `excerpt.rendered`, strips cross-reference lines to prevent rating contamination, HTML→plain text via cheerio
- **Parallel-safe:** Only commits `review-texts/` and `aggregator-archive/nysr/`

## `scrape-new-aggregators.yml`
- **Runs:** Weekly on Sundays at 11 AM UTC (after NYSR), or manually. Also triggered per-show via `gather-reviews.yml` scrape-aggregators job.
- **Does:** Scrapes Playbill Verdict (review URL discovery) and NYC Theatre roundups (excerpt extraction), then rebuilds `reviews.json`
- **Options:** `aggregator` (all/playbill-verdict/nyc-theatre), `shows` (comma-separated show IDs for targeted runs)
- **Requires:** SCRAPINGBEE_API_KEY (for Google search + page fetching)
- **Optional:** BRIGHTDATA_TOKEN (fallback for Playbill Verdict)
- **Scripts:** `scripts/scrape-playbill-verdict.js` (`--shows=X,Y,Z`, `--no-date-filter`), `scripts/scrape-nyc-theatre-roundups.js` (`--shows=X,Y,Z`)
- **NYC Theatre:** Only processes shows from 2023+, skip-if-exists caching via `data/aggregator-archive/nyc-theatre/`
- **Parallel-safe:** Only commits `review-texts/` and `aggregator-archive/`, rebuild commits `reviews.json`

## `scrape-bww-reviews.yml`
- **Runs:** Weekly on Sundays at 1 PM UTC (after existing scrapers), or manually
- **Does:** Scrapes BWW `/reviews/` pages (1-10 scores, review URLs, excerpts) and BWW Review Roundup articles (thumb up/meh/down, review URLs, excerpts), then rebuilds `reviews.json`
- **Options:** `type` (all/reviews/roundup), `shows` (comma-separated show IDs), `limit` (default 200), `force` (override cache)
- **Requires:** BRIGHTDATA_TOKEN (primary), SCRAPINGBEE_API_KEY (fallback)
- **Script:** `scripts/scrape-bww-reviews.js`
- **Three BWW formats handled:** (1) `/reviews/` pages with 1-10 scores, (2) new-format roundups (~2023+) with thumb images, (3) old-format roundups (pre-2023) with plain text
- **Checkpointing:** Every 25 shows in CI with git push retry
- **Archives:** `data/aggregator-archive/bww-reviews/` (review pages), `data/aggregator-archive/bww-roundups/` (roundup articles)
- **Parallel-safe:** Only commits `review-texts/` and `aggregator-archive/`, rebuild commits `reviews.json`

## `scrape-dtli-show-score.yml`
- **Runs:** Weekly on Sundays at 3 PM UTC (after BWW at 1 PM), or manually
- **Does:** Discovers DTLI slugs from sitemaps, fetches DTLI + Show Score aggregator pages, extracts reviews, rebuilds `reviews.json`
- **Options:** `aggregator` (all/dtli/show-score), `shows` (comma-separated/"all"/"missing", default missing), `force` (re-fetch existing)
- **Job pipeline (4 jobs):**
  1. `discover-dtli-slugs` — Scrapes 13 DTLI WordPress sitemaps, matches slugs to our shows, writes `data/dtli-slug-map.json`
  2. `fetch-dtli` (needs #1) — `npx tsx scripts/fetch-aggregator-pages.ts --aggregator dtli --shows missing` → archives to `data/aggregator-archive/dtli/`
  3. `fetch-show-score` (parallel with #2) — `npx tsx scripts/fetch-aggregator-pages.ts --aggregator show-score --shows missing` → archives to `data/aggregator-archive/show-score/`
  4. `extract-and-rebuild` (needs #2 + #3) — Extracts reviews from archives, rebuilds reviews.json, auto-triggers text collection if >20 reviews need it
- **Key data file:** `data/dtli-slug-map.json` — persistent mapping of our show IDs to DTLI URL slugs (discovered from sitemaps, 583+ entries)
- **Scripts:** `scripts/discover-dtli-slugs.js`, `scripts/fetch-aggregator-pages.ts`, `scripts/extract-dtli-reviews.js`, `scripts/rebuild-all-reviews.js`
- **Requires:** `SCRAPINGBEE_API_KEY` (for Show Score), Playwright (installed in CI)
- **Parallel-safe:** Each job commits only its own data, 5-retry push with rebase
- **Manual trigger:** `gh workflow run "Scrape DTLI & Show Score Pages" -f aggregator=dtli -f shows=hamilton-2015,cabaret-2024`

## `audit-aggregator-coverage.yml`
- **Runs:** Weekly on Mondays at 6 AM UTC, or manually
- **Does:** Audits review coverage across all 6 aggregator sources (DTLI, Show Score, BWW Roundups, BWW Reviews, Playbill Verdict, NYC Theatre) for all shows. Compares archive-extracted counts against local review files to identify genuine coverage gaps.
- **Options:** `status` (open/closed/all, default all), `show` (single show ID for targeted audit)
- **Script:** `scripts/audit-aggregator-coverage.js`
- **Output:** `data/audit/aggregator-coverage.json` — per-show gap analysis with `trulyMissing` metric
- **Key metrics:**
  - Per-aggregator gaps: how many reviews each aggregator lists that we don't have attributed to that source
  - `trulyMissing = max(0, maxAggregatorCount - totalLocal)`: genuine missing reviews (not just source attribution differences)
  - ~97% of per-aggregator gaps are source-attribution differences, not truly missing reviews
- **No secrets needed** (reads local files only)
- **Parallel-safe:** Only commits `data/audit/aggregator-coverage.json`
- **CLI:** `node scripts/audit-aggregator-coverage.js --output-gaps` (prints show IDs with genuine gaps for piping to gather-reviews)

## `close-coverage-gaps.yml`
- **Runs:** Manual trigger only (workflow_dispatch)
- **Does:** Orchestrates full coverage gap closure for a given era: audits gaps, gathers reviews in parallel (aggregators-only mode), scrapes PV/NYC Theatre, validates, rebuilds reviews.json
- **Options:**
  - `era`: `2021-2026` | `2016-2020` | `2011-2015` | `pre-2011` | `all`
  - `parallel_jobs`: Number of parallel gather jobs (1-10, default 5)
  - `dry_run`: Audit only, no gathering
- **Manual trigger:**
  ```bash
  gh workflow run "Close Coverage Gaps" --field era="2021-2026" --field parallel_jobs=5 --field dry_run=false
  ```
- **Job pipeline (4 jobs):**
  1. `prepare` — Filters shows by era, runs coverage audit, identifies gap shows, partitions into matrix batches, uploads gap-data artifact
  2. `gather-gaps` (matrix, N parallel jobs) — Runs `gather-reviews.js --aggregators-only` per show, checkpoint commits every 10 shows, pre-commit JSON validation, failure tracking via artifacts. No ANTHROPIC_API_KEY needed.
  3. `scrape-pv-nyc` — Runs Playbill Verdict + NYC Theatre for gap shows (60 min, continue-on-error)
  4. `rebuild` — Validates data, rebuilds reviews.json, writes step summary
- **Requires:** SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN (no ANTHROPIC_API_KEY needed — aggregators-only mode)
- **Performance:** ~20 sec/show (vs ~5 min/show previously). 100 gap shows in ~7 min with 5 parallel jobs.
- **Parallel-safe:** Matrix strategy with round-robin distribution, 30s stagger, 5-retry push with rebase, fail-fast: false, pre-commit JSON validation, atomic file writes

## `fetch-todaytix-showtimes.yml`
- **Runs:** Daily at 6 AM UTC (1 AM EST), or manually
- **Does:** Fetches performance-level showtime IDs from TodayTix public API for all open shows with `todaytixId`. Also generates `show-schedules.json` entries for WE/OB shows (Broadway uses bwayrush). Cleans up closed WE/OB shows from schedules.
- **Script:** `scripts/fetch-todaytix-showtimes.js`
- **No secrets needed** (public TodayTix API)
- **Data files:** `data/todaytix-showtimes.json` (deep-link IDs), `data/show-schedules.json` (weekly schedule grid)
- **Safety guard:** Aborts if <50% of shows return data (prevents silent data loss from API outage)
- **Monitored by:** `check-cron-health.yml` (36h max gap)
- **Validated by:** `validate-data.js` (staleness, coverage, structural integrity)
- **CLI:** `node scripts/fetch-todaytix-showtimes.js [--dry-run] [--limit N]`

## `fix-todaytix-links.yml`
- **Runs:** Weekly on Mondays at 10 AM EST (3 PM UTC), or manually
- **Does:** Checks all TodayTix URLs in shows.json via HEAD requests. Detects 404s and wrong-show redirects (ID recycling) by comparing page `<title>`. Auto-fixes broken links using TodayTix public API (`api.todaytix.com/api/v2/shows?query=NAME&location=1`). Removes stale links for closed shows. Commits fixes directly.
- **Script:** `scripts/fix-todaytix-links.js`
- **No secrets needed** (public TodayTix API + HEAD requests)
- **CLI:** `node scripts/fix-todaytix-links.js [--dry-run]`

## `fix-platform-ticket-links.yml`
- **Runs:** Monthly (1st Monday at 4 PM UTC), or manually
- **Does:** Validates Telecharge/Ticketmaster links (separate from TodayTix). Telecharge: verifies URL matches deterministic construction from title. Ticketmaster: re-verifies via SERP. Removes stale links for closed shows. Also runs official URL enrichment for Broadway shows.
- **Scripts:** `scripts/fix-platform-ticket-links.js`, `scripts/enrich-official-urls.js --category=broadway`
- **Requires:** SCRAPINGBEE_API_KEY (for Ticketmaster SERP + official URL SERP)
- **Note:** Neither Telecharge (Akamai queue-it → 302) nor Ticketmaster (requires JS) can be HTTP-verified. Validation uses URL construction matching and SERP re-verification respectively.
- **CLI:** `node scripts/fix-platform-ticket-links.js [--dry-run]`

## `test.yml`
- **Runs:** On push to `main`, daily at 6 AM UTC, manually
- **Tests:** Data validation (duplicates, required fields, dates, status), **text quality audit** (35% full, <40% truncated, <5% unknown), E2E tests (homepage, show pages, navigation, filters, mobile)
- **Quality thresholds:** Fails if review text quality drops below standards
- **On Failure:** Auto-creates GitHub issue (Discord alerts removed Feb 20, 2026)

## `check-secrets-health.yml`
- **Runs:** Weekly on Mondays at 12 PM UTC (7 AM EST), or manually
- **Does:** Tests 10 critical service API keys/tokens for validity + balance/quota where available
- **Services tested:**
  - Anthropic, OpenAI, Gemini: key validity via `GET /models` (free, no token cost)
  - OpenRouter: key validity + `limit_remaining` balance (warns <$5, fails <$1)
  - ScrapingBee: key validity + credit usage (warns >50% monitor, >75% opening nights at risk)
  - Bright Data: `mcp_unlocker` zone status — verifies `disable` field absent (catches trial limit + soft-delete before opening night)
  - Private Repo PAT (`REVIEW_TEXTS_TOKEN`): repo access
  - Vercel: token validity via `GET /v2/user`
  - Sentry: token validity via project API
  - Resend: token validity via `GET /domains`
- **All checks run in parallel** via `Promise.all()` for speed
- **On failure:** Sends Discord alert + email to owner (`email: true`)
- **Script:** `scripts/check-secrets-health.js`
- **Requires:** ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN, REVIEW_TEXTS_TOKEN, VERCEL_TOKEN, SENTRY_AUTH_TOKEN, RESEND_API_KEY, DISCORD_WEBHOOK_ALERTS, OWNER_EMAIL
- **Manual trigger:** `gh workflow run "Check Secrets Health"`

## `check-seo-health.yml`
- **Runs:** Weekly on Sundays at 8 AM UTC, or manually
- **Does:** Comprehensive SEO health monitoring via Google Search Console APIs. 5 features: (1) search performance tracking (clicks, impressions, CTR, position vs prior week + top queries/pages), (2) index coverage sampling (URL Inspection API on 50 random show URLs), (3) sitemap status verification, (4) new page indexing (auto-resubmits shows opened 2-7 days ago if not indexed), (5) stale page detection (resubmits pages with lastCrawlTime >30 days, capped at 50/week)
- **Anomaly detection:** Compares current week to 4-week rolling average. Alerts on clicks down >25%, impressions down >30%, position worse by >5. Seasonality guard: if 52+ weeks of history, suppresses alerts that match same-week-last-year pattern (within 30%).
- **Data persistence:** `data/audit/seo-health.json` (latest snapshot), `data/audit/seo-performance-history.json` (52-week rolling history), `data/audit/indexing-api-usage.json` (shared daily quota ledger, 200/day)
- **Script:** `scripts/check-seo-health.js` (imports from `scripts/submit-google-indexing.js`)
- **Requires:** GOOGLE_INDEXING_KEY, DISCORD_WEBHOOK_ALERTS, RESEND_API_KEY, OWNER_EMAIL, REVIEW_TEXTS_TOKEN (for checkout-core-data)
- **Alerts:** Discord for warnings, Discord + email for errors (>20% traffic drop or >10% deindexing)
- **Manual trigger:** `gh workflow run "Check SEO Health"`
- **Note:** Audit data pushes do NOT trigger Vercel deploys (seo-* paths not in deploy trigger list). Commit uses `[skip ci]`.

## `update-deploy-watermark.yml`
- **Runs:** Dispatched by `vercel-deploy.yml` after each successful production deploy
- **Does:** Commits updated `data/audit/deploy-watermark.json` (show/review counts) used by `pre-deploy-check.js` as a regression baseline
- **Why async:** Push retries on concurrent branches took ~2 min inline. Moved to separate workflow to unblock deploy completion.
- **Concurrency:** `deploy-watermark-update` group, `cancel-in-progress: true` (only latest watermark matters)
- **Requires:** REVIEW_TEXTS_TOKEN (for checkout-core-data — reads shows.json/reviews.json)
- **If it fails:** Pre-deploy check uses a slightly stale baseline. Absolute floors (500 shows, 10K reviews) are the real safety net.

## `vercel-demo.yml`
- **Runs:** Every 8 hours (6 AM, 2 PM, 10 PM UTC), or manually
- **Does:** Builds and deploys to `demo.broadwayscorecard.com` with ALL feature flags enabled. For partner meetings (TodayTix, ShowScore) where feature-flagged content needs to be visible.
- **Key difference from production:** Rewrites `feature-flags.ts` source at build time to enable ALL flags (auto-extracted from getter names — no manual sync needed). Deploys WITHOUT `--prod` (cannot touch production). Uses `vercel alias set` to assign `demo.broadwayscorecard.com`.
- **Concurrency:** `vercel-demo-deploy` group, `cancel-in-progress: false` (queued). **DO NOT change to `true`** — cancelling mid-build leaves the demo alias pointing at stale production content without feature flags. Queuing adds ~13min delay but guarantees the alias always points at a flag-rewritten build.
- **Requires:** VERCEL_TOKEN, REVIEW_TEXTS_TOKEN (for checkout-core-data)
- **Manual trigger:** `gh workflow run "Deploy Demo Site"`
