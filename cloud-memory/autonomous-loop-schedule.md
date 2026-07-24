# Autonomous Loop — Cron Map & Schedule Pick

Generated 2026-07-12 from `grep -rn "cron:" .github/workflows/`.

**Count check:** grep found **161** `cron:` lines. **157** are active schedule entries (all listed below: 12 in section 1 + 145 in section 2 = 157 ✓). The other 4 are non-schedules: `scrape-stagedoor.yml:13` (disabled, domain dead), `update-commercial.yml:7` (commented out), `rebuild-fast.yml:17` and `recover-explicit-ratings.yml:103` (prose comments containing the word "cron:"). 157 + 4 = 161 ✓.

## 1. Continuous / sub-hourly crons (12) — cannot be avoided, only acknowledged

| Frequency | Workflow | Purpose |
|---|---|---|
| every 5 min | vercel-deploy.yml | deploy main HEAD to Vercel |
| every 5 min | aggregator-url-watcher.yml | watch for new aggregator review pages |
| every 5 min | demo-alias-watchdog.yml | keep demo alias pointed correctly |
| every 10 min | process-feedback.yml | process user feedback queue |
| every 15 min | opening-night-completeness-check.yml | opening-night review completeness |
| every 30 min | check-opening-night-drift.yml | opening-night drift check |
| every 30 min | vercel-build-guard.yml | guard against rogue Vercel builds |
| hourly :00 | commercial-rss-poll.yml | Variety/Deadline recoupment RSS |
| hourly :00 (Apr–Jun) | update-tony-odds.yml | Tony odds refresh |
| hourly :17 | opening-night-checklist.yml | opening-night checklist sweep |
| hourly :37 | audit-aggregator-gap.yml | aggregator coverage gap audit |
| hourly 11:00–18:00 | reconcile-broadcast-state.yml | reconcile email broadcast state |

Because :00 / :17 / :37 fire every hour, the largest possible distance from a sub-hourly cron is ~11 min. These run on GitHub infra and are acknowledged, not avoided.

## 2. Discrete crons (145), sorted by UTC time

| UTC | Days | Workflow | Purpose |
|---|---|---|---|
| 00:00 | daily | opening-night-orchestrator.yml | Broadway evening backup (~10 PM ET actual) |
| 00:00 | Sun | collect-review-texts.yml | weekly full text-collection sweep |
| 00:00,06,12,18 | daily | mirror-to-gitlab.yml | mirror web repo to GitLab |
| 00:00,06,12,18 | daily | mirror-review-texts-to-gitlab.yml | mirror review-texts repo |
| 00:00,06,12,18 | daily | mirror-data-to-gitlab.yml | mirror data repo |
| 00:15,06:15,12:15,18:15 | daily | sentry-triage.yml | Sentry error triage |
| 00:45,04:45,08:45,… (*/4h) | daily | rebuild-fast.yml | fast static-page refresh |
| 01:00 | daily | reddit-engagement-digest.yml | Reddit engagement digest (evening run) |
| 01:00 | Sun | rediscover-urls.yml | rediscover dead review URLs |
| 02:00 | Sun | update-critic-consensus.yml | critic consensus refresh |
| 03:00 | Sun | weekly-integrity.yml | weekly data integrity audit |
| 03:00 | Mon | generate-guide-editorials.yml | guide editorial generation |
| 03:00 | 1st | generate-related-shows.yml | related-shows regeneration |
| 03:45 | daily | refresh-show-score-opening-night.yml | Show Score opening-night refresh |
| 04:00 | daily | rebuild-reviews.yml | full reviews.json rebuild |
| 04:00 | Mon | weekly-video-reviews.yml | video review collection |
| 04:30,10:30,18:30 | daily | collect-review-texts.yml | review text collection |
| 04:30,10:30,16:30,22:30 | daily | enrich-reviews.yml | review enrichment |
| 04:30 | daily | llm-ensemble-score.yml | LLM ensemble scoring |
| 05:00 | daily | opening-night-reviews.yml | opening-night review gather (AM) |
| 05:00 | daily | opening-night-orchestrator.yml | West End morning (~6:30 UTC actual) |
| 05:00 | Mon,Wed,Fri | weekly-nyt-critics-picks.yml | NYT Critics' Picks scrape |
| 05:00 | Tue | audit-review-quality.yml | review quality audit |
| 05:00 | 1st | scoring-audit.yml | monthly scoring audit |
| 05:15 | daily | adjudicate-review-queue.yml | adjudicate flagged-review queue |
| 06:00 | daily | check-review-count-drift.yml | review count drift check |
| 06:00 | daily | check-show-freshness.yml | show freshness check |
| 06:00 | daily | fetch-todaytix-showtimes.yml | TodayTix showtimes |
| 06:00 | daily | test.yml | nightly test suite |
| 06:00,14,22 | daily | vercel-demo.yml | demo deploy refresh |
| 06:00 | Mon | process-review-formspree.yml | Formspree review submissions |
| 06:00 | Mon | check-cutoff-freshness.yml | cutoff freshness check |
| 06:00 | Mon | audit-aggregator-coverage.yml | aggregator coverage audit |
| 06:00 | Mon | update-social-pulse.yml | social pulse update |
| 06:00 | Mon,Thu | fetch-all-image-formats.yml | image format fetch |
| 06:00 | Wed | backfill-cast.yml | cast backfill |
| 06:00 | Wed | update-show-status.yml | weekly deep status pass |
| 06:00 | Sun | regenerate-tier-configs.yml | tier config regeneration |
| 06:00 | Sun | audit-cross-production.yml | cross-production contamination audit |
| 06:00 | Sun | submit-indexnow.yml | IndexNow SEO submission |
| 06:00 | Sat | purge-archives-history.yml | archive history purge |
| 06:00 | 1st | scrape-alltime-grosses.yml | all-time grosses scrape |
| 06:00 | 1st of Jan/Apr/Jul/Oct | generate-theater-tips.yml | quarterly theater tips |
| 06:20 | daily | check-corpus-drift.yml | corpus drift check |
| 07:00 | daily | recover-wsj-subscriber.yml | WSJ subscriber-access recovery |
| 07:00 | daily | poll-loureviews.yml | LouReviews UK poll |
| **16:00** | **daily** | **data-health-check.yml (BSC digest carrier)** | **moved 07:00→16:00 UTC 2026-07-24 (card #409) — ≥3h from the overnight approval email; see check-cron-health.yml 26h note** |
| 07:00 | Mon | enrich-west-end-dates.yml | West End date enrichment |
| 07:00 | Mon | scrape-theatre-reviews.yml | theatre.reviews scrape |
| 07:00 | Mon | enrich-runtimes.yml | runtime enrichment |
| 07:00 | Tue | scrape-thestage-roundups.yml | The Stage roundup scrape |
| 07:00 | Wed | enrich-ibdb-dates.yml | IBDB date enrichment |
| 07:15 | Mon | enrich-off-broadway-dates.yml | Off-Broadway date enrichment |
| **07:30** | **daily** | **← AUTONOMOUS LOOP (launchd, 3:30 AM ET)** | **see section 4** |
| 08:00 | daily | update-show-status.yml | daily show status update |
| 08:00 | daily | commercial-stale-closures.yml | stale closure check |
| 08:00 | daily | collect-we-ob-reviews.yml | WE/OB review collection |
| 08:00 | daily | opening-night-orchestrator.yml | Broadway morning (~9 UTC actual) |
| 08:00 | Mon | posthog-monday.yml | PostHog Monday analytics |
| 08:00 | Tue | sweep-we-aggregators.yml | WE aggregator sweep |
| 08:00 | Wed | fetch-guardian-reviews.yml | Guardian review fetch |
| 08:00 | Thu | enrich-west-end-dates.yml | WE date enrichment (2nd pass) |
| 08:00 | Sat | audit-bww-rr-attributions.yml | BWW RR attribution audit |
| 08:00 | Sun | check-seo-health.yml | SEO health check |
| 08:15 | Thu | enrich-off-broadway-dates.yml | OB date enrichment (2nd pass) |
| 09:00 | daily | review-refresh.yml | per-show SERP review refresh |
| 09:00 | Mon | snapshot-audience-history.yml | audience history snapshot |
| 09:00 | Mon | audit-critic-coverage.yml | critic coverage audit |
| 09:00 | Mon | weekly-geo-audit.yml | GEO/AI-search audit |
| 09:00 | Wed,Sat | update-cast-changes.yml | cast change update |
| 09:00 | Sun | check-cwv-health.yml | Core Web Vitals check |
| 09:07 | Sun | audit-touring-contamination.yml | touring contamination audit |
| 10:00 | Mon,Thu | update-lottery-rush.yml | lottery/rush update |
| 10:00 | Sun | scrape-nysr.yml | NY Stage Review scrape |
| 10:00 | 1st | update-reddit-sentiment.yml | Reddit sentiment (monthly) |
| 10:00 | 4th | update-reddit-sentiment.yml | Reddit sentiment (retry) |
| 10:00 | 15th | update-reddit-sentiment.yml | Reddit sentiment (mid-month) |
| 10:00 | 18th | update-reddit-sentiment.yml | Reddit sentiment (retry) |
| 10:30 | Sun | scrape-wp-blogs.yml | WordPress blog scrape |
| 11:00 | daily | opening-digest.yml | opening digest email (7 AM ET) |
| 11:00 | daily | outlet-listing-poller.yml | outlet listing poll |
| 11:00 | Sat | newsletter-draft.yml | newsletter draft |
| 11:00 | Sun | check-show-metadata-consensus.yml | metadata consensus check |
| 11:17 | daily | finance-ingest.yml | finance data ingest |
| 11:30 | daily | clear-stale-duplicate-of.yml | stale duplicateOf clearing |
| 11:30 | Mon | check-url-health.yml | URL health check |
| 11:30 | Sat | we-newsletter-draft.yml | WE newsletter draft |
| 11:40 | daily | fix-circular-duplicate-pairs.yml | circular duplicate-pair fix |
| 11:50 | daily | dedupe-same-url-bylines.yml | same-URL byline dedupe |
| 12:00 | daily | check-cron-health.yml | cron health check (verifies AM crons fired) |
| 12:00 | daily | lighthouse-post-deploy.yml | Lighthouse audit |
| 12:00 | daily | sync-followers.yml | follower sync |
| 12:00 | daily | daily-digest.yml | daily digest email (8 AM ET) |
| 12:00 | Mon | check-secrets-health.yml | secrets health check |
| 12:00 | Sat | snapshot-award-scores.yml | award score snapshot |
| 12:00 | Sun | update-show-score.yml | Show Score update |
| 12:00 | 1st | rotate-apple-secret.yml | Apple secret rotation |
| 12:00 | 1st | rotate-gitlab-token.yml | GitLab token rotation |
| 12:00 | 8th | update-reddit-sentiment.yml | refresh-stale drain |
| 12:30 | daily | opening-night-broadcast.yml | opening-night broadcast email (8:30 AM ET) |
| 13:00 | daily | reddit-engagement-digest.yml | Reddit engagement (morning run) |
| 13:00 | daily | opening-night-stage-alert.yml | Stage alert, 48h lookback (9 AM ET) |
| 13:00 | Mon | weekly-affiliate-report.yml | affiliate report |
| 13:00 | Sun | update-mezzanine.yml | Mezzanine update |
| 13:00 | Sun | scrape-bww-reviews.yml | BWW reviews scrape |
| 13:17 | daily | brand-mention-monitor.yml | brand mention monitor |
| 13:17 | daily | test-ugc-roundtrip.yml | UGC roundtrip test + Supabase keep-alive |
| 13:30 | Mon | weekly-stubhub-validate.yml | StubHub link validation |
| 14:00 | Mon–Sat | scrape-new-aggregators.yml | new-aggregator scrape (daily mode) |
| 14:00 | Sun | scrape-new-aggregators.yml | new-aggregator scrape (weekly mode) |
| 14:00 | daily | audit-closing-dates.yml | closing date audit |
| 14:00 | Mon | collect-outlet-reviews.yml | outlet review collection |
| 14:00 | Mon | scraper-cost-report.yml | scraper cost report |
| 14:00 | Mon | send-follow-notifications.yml | follow notifications |
| 14:00 | Mon | scrape-waltz-costs.yml | Waltz cost scrape |
| 14:00 | Tue | check-cookie-health.yml | cookie health check |
| 14:00 | Fri | check-cookie-health.yml | cookie health check (2nd) |
| 14:00 | Tue (Apr–Jun) | snapshot-audience-grades.yml | audience grade snapshot |
| 14:00 | Sun | audit-cross-production-weekly.yml | cross-production weekly audit |
| 14:00 | Sun | update-theatr.yml | Theatr update |
| 15:00 | daily | audit-opening-dates.yml | opening date audit |
| 15:00 | daily | opening-night-reviews.yml | opening-night review gather (PM) |
| 15:00 | daily | social-post.yml | social post |
| 15:00 | Mon | fix-todaytix-links.yml | TodayTix link fix |
| 15:00 | Mon | collection-coverage-report.yml | collection coverage report |
| 15:00 | Tue | weekly-grosses.yml | weekly grosses |
| 15:00 | Wed | weekly-grosses.yml | weekly grosses (retry) |
| 15:00 | Sun | update-seatplan.yml | SeatPlan update |
| 15:00 | Sun | scrape-dtli-show-score.yml | DTLI + Show Score scrape |
| 15:30 | Sun | update-lbo.yml | London Box Office update |
| 16:00 | daily (Apr–Jun) | update-tony-awards.yml | Tony awards update |
| 16:00 | Sun | update-broadway-com.yml | Broadway.com update |
| 16:00 | Sun | update-ltd.yml | LTD update |
| 16:00 | 1st Mon of month | fix-platform-ticket-links.yml | platform ticket link fix |
| 17:00 | daily (Apr–May) | update-precursor-awards.yml | precursor awards (season) |
| 17:00 | Mon | update-precursor-awards.yml | precursor awards (catch-up) |
| 17:00 | Sun | scrape-westendtheatre.yml | WestEndTheatre scrape |
| 17:00 | 1st | update-broadway-com.yml | Broadway.com monthly full |
| 18:00 | daily | opening-night-orchestrator.yml | West End evening (~19 UTC actual) |
| 18:00 | Wed | fantasy-weekly.yml | fantasy league weekly |
| 18:00 | Sat | commercial-weekly.yml | commercial weekly digest |
| 20:00 | Sun | recollect-for-scores.yml | recollect texts for scoring |
| 20:00 | Sun | recover-explicit-ratings.yml | explicit rating recovery |
| 22:00 | Fri | commercial-friday.yml | commercial Friday prep |
| 23:00 | daily | opening-night-orchestrator.yml | Broadway evening primary (~1 AM UTC actual) |
| 23:00 | daily | drain-not-attempted.yml | drain not-attempted queue |

Note: CLAUDE.md §14 says orchestrator fires "3 AM UTC Broadway / 10 PM UTC West End" — the workflow file is authoritative and has 5 entries (23:00, 00:00, 05:00, 08:00, 18:00 UTC scheduled; GHA lag makes actual fire times 1–2h later).

**Bursts (several workflows within 30 min):** 04:00–05:15 UTC (rebuild → collect → enrich → LLM score → opening-night → adjudicate chain, daily); 06:00 UTC (4 daily + up to 4 weekly on Mondays, +3 Sundays); 07:00 UTC (3 daily + 3 Mondays); 08:00 UTC (4 daily incl. orchestrator + 1 weekly/day + local backfill-gather); 11:00–12:30 UTC (digest/broadcast + dedupe band, ~10 jobs); 14:00–15:00 UTC (scraper band, 8+ on Mondays/Sundays).

## 3. Local launchd jobs (Mac Studio; StartCalendarInterval = **local ET**) & crontab

`crontab -l`: empty. Project-related plists in `~/Library/LaunchAgents/`:

| Plist | Schedule | Notes |
|---|---|---|
| com.broadwayscore.backfill-gather | daily 04:00 ET (= 08:00 UTC in EDT) | backfill gather run |
| com.broadwayscore.worktree-gc | Sun 04:00 ET | worktree garbage collection |
| com.bwsc.nightly-digest | daily 23:00 ET (= 03:00 UTC) | nightly digest |
| com.bwsc.opening-night-backup-trigger | daily 21:00 ET (= 01:00 UTC) | orchestrator backup trigger |
| com.bwsc.weekly-retro | Sun 10:00 ET | weekly retro |
| com.tompryor.claude-token-health | daily 09:30 ET | token health check |
| com.tompryor.claude-token-soak | Jun 30 09:00 (one-shot) | expired |
| com.broadwayscore.claude-email-worker | every 300s | continuous |
| com.broadwayscore.claude-email-worker-health | every 14400s (4h) | continuous |
| com.bwsc.action-dispatcher | every 300s | continuous |
| com.claude.memory-sync | every 300s | continuous |
| com.tompryor.gh-zombie-reap | every 120s | continuous |
| com.tompryor.timewait-monitor | every 60s | continuous |
| com.bwsc.opening-night-monitor-phase1/2/3 | — | disabled 2026-06-04 |

## 4. Chosen nightly slot: **07:30 UTC (3:30 AM ET, EDT) daily**

**Nearest-conflict clearance: 30 minutes** (both sides, among discrete crons):
- 30 min after the 07:00 UTC daily trio (recover-wsj-subscriber, data-health-check, poll-loureviews — all lightweight, no data-repo writes of consequence).
- 30 min before the 08:00 UTC burst (update-show-status, commercial-stale-closures, collect-we-ob-reviews, orchestrator Broadway-morning) and local backfill-gather (04:00 ET).
- Opening-night orchestrator entries: WE-morning 05:00 UTC = 150 min before; Broadway-morning 08:00 UTC = 30 min after; Broadway-evening 23:00/00:00 UTC = 7.5h+ away.
- Rebuild/scoring chain (04:00–05:15 UTC) and nightly test.yml (06:00 UTC) finish well before 07:30.

**Known exception:** Mondays, `enrich-off-broadway-dates` fires 07:15 UTC — 15 min clearance. Exhaustive scan of all discrete fire times in the 04:00–11:00 UTC window (04:00, 04:30, 04:45, 05:00, 05:15, 06:00, 06:15, 06:20, 07:00, 07:15, 08:00, 08:15, 08:45, 09:00, 09:07, 10:00, 10:30, 11:00) shows the largest all-days gap is 53 min (09:07→10:00), so **no slot in the night window achieves ≥30 min on all 7 days**; 07:30 achieves it 6 of 7 days and the Monday neighbor is a lightweight GitHub-side metadata enricher. Sub-hourly crons (:00/:17/:37 hourly, */5 deploys) are acknowledged per section 1 — max achievable distance from them is ~11 min anywhere.

**Why not the wider 09:00→10:30 gap (e.g. 09:45 UTC = 5:45 AM ET):** the loop runs 1–3 h and must finish before the morning email; a 5:45 AM ET start could run to 8:45 AM ET, past the send time and into the user's morning. Starting 3:30 AM ET, even a 3-hour run ends 6:30 AM ET — a full hour before the email.

## 5. Chosen email time: **7:30 AM US/Eastern daily** (11:30 UTC in EDT)

Within the repo's 7–9 AM ET broadcast-quality-bar convention (transactional owner-only send, not a broadcast). Slots between the two automated emails the user already receives — opening-digest (7:00 AM ET) and daily-digest (8:00 AM ET) — so the evidence digest is visually distinct in the inbox. The loop is guaranteed finished ≥1 h before send.

## 6. Revisit when

- **DST fallback (Nov 1, 2026):** launchd fires at local time, so 3:30 AM EST = 08:30 UTC — only 15 min from Thu 08:15 and daily 08:45 rebuild-fast. At fallback, change the loop plist to **2:30 AM local** so it stays at 07:30 UTC. The email plist stays at 7:30 AM local year-round — the 7–9 AM wall-clock convention wins for the email; UTC alignment wins for the loop.
- **Any new cron added between 06:45–08:15 UTC** (or a new local launchd job between 2:30–4:30 AM ET) — re-run the gap scan in section 4.
- **Sunday worktree-gc at 4:00 AM ET** runs while the loop (which works in a worktree) is active — confirm the GC script skips locked/active worktrees before first Sunday run.
- Orchestrator schedule changes in `opening-night-orchestrator.yml` (5 entries today) — the loop's 30-min clearance to the 08:00 UTC Broadway-morning entry is the tightest orchestrator margin.

## 5. Sprint-2 install record (2026-07-13)
Installed on the Mac Studio (both loaded via `launchctl bootstrap gui/$UID`):
- `com.broadwayscore.autonomous-nightly` — 03:30 ET → scripts/autonomous-nightly.sh (triage → executor → owner email). Plist template: scripts/launchd/.
- `com.broadwayscore.autonomous-deadman` — 09:00 ET → scripts/autonomous-deadman.js (alerts if ledger silent >24h; armed = plist exists AND job actually loaded, so `launchctl bootout` silences it).
First live night config: $5 / S-only / max 3 (.claude/autonomous-config.json; ownerEmail comes from OWNER_EMAIL in .env — committed config keeps null, public repo).
Kill switches: `launchctl bootout gui/$UID/com.broadwayscore.autonomous-nightly` (and .autonomous-deadman). Ledger: data/audit/autonomous-ledger.jsonl (gitignored, Mac-Studio-local).
Note: email send time is currently the tail of the 03:30 nightly run, NOT a separate 7:30 AM plist — revisit in Sprint 3 if the owner wants the email at wake-up time instead of at run-end.
