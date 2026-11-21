# Opening-night review ingestion: why it keeps failing, and what to change

**Date:** 2026-09-28 (written the morning of the School Girls opening)
**Scope:** every system that ingests reviews on a Broadway opening night, the last Broadway opening (Paranormal Activity, Aug 25), and the post-mortems since March.
**Linear:** BRO-4207

---

## 1. Bottom line

1. **School Girls opens tonight, Monday Sept 28, not tomorrow.** Playbill lists "Opening Night: Sep 28 2026" and BroadwayWorld's Sept 27 preview says "ahead on opening night, September 28." shows.json agrees. Reviews will most likely publish between 9:00 PM and 10:30 PM ET tonight (Paranormal Activity's went up at about 9:00 PM).

2. **On the current system, even a night where nothing breaks lands the first batch of reviews on the site 2.5 to 3.5 hours after they publish, not within one hour.** This is not a bug. It is how the pieces are timed:
   - The "every 5 minutes" aggregator watcher (the only fast path) has actually run once every 3.7 hours on average for the last week (40 runs between Sept 22 and Sept 28), because GitHub throttles frequent crons in a repository this busy.
   - Even when it does run, it refuses to dispatch while a multi-show poller is active, and a multi-show poller is active all night: the orchestrator's poller sweeps every show in the 21-day window (35 to 44 shows, mostly Off-Broadway), each pass takes 54 to 94 minutes, and it only scores, rebuilds and deploys after the last show in the pass.
   - The orchestrator's 7 PM ET cron has fired between 8:50 and 9:25 PM ET the last three nights, so its first pass usually visits the show before the embargo lifts, and its second pass (the one that finds the roundup) starts around 11 PM.

3. **The "50 attempts, every session claims it is fixed" pattern is structural.** The opening-night path is the general corpus pipeline (247 workflows, 61,545 lines of workflow YAML, four core scripts totalling 21,855 lines, 116 protected fields, and 122 workflows that push to the two private data repos) asked to behave like a real-time system for one show. Every incident adds a guard; every guard is a new way to lose a review; the catalog of documented "silent gate" classes now has 67 entries, 56 of them dated September. Fixes are real but local, verified in isolation, and the next night fails through a combination nobody tested. A $200-a-night headless Claude "monitor" that re-derives the situation from scratch every 20 minutes is the current answer, and it has spent whole nights fetching nothing (no .env, Aug 26) or failing its own auth check three times a day (Sept 14 to 25).

4. **Recommendation: do not patch tonight. Run tonight with the short playbook in section 2, then build a separate, small "opening-night lane"** that owns one show for one night end to end (section 6), rehearses against a recorded past opening before every real one, and refuses to arm if the rehearsal fails. Roughly two to three weeks of focused work. There are eleven Broadway openings between Oct 18 and Dec 6 to prove it on.

5. **Two show-specific problems need fixing today, by a local session with the private repos:**
   - shows.json credits **Rebecca Taichman** as director. She directed the 2017 MCC production. The 2026 Broadway production is directed by **Whitney White** (Playbill, Wikipedia). Tonight's reviews will say "directed by Whitney White", and the wrong-production classifier treats a director name that is not on the show's creative team as proof the review is about a different production. That veto blocks the very override that exists to protect same-title revivals. Fix the creative team before 8 PM ET.
   - The poller already wrote files for this show on Aug 21 (its backoff ledger records new files that day, during previews). Those files are in the private review-texts repo, which this cloud session cannot read. They are probably 2017 MCC reviews or preview-period features. Check them, and delete (plus blocklist) anything from 2017 rather than flagging it.

---

## 2. Tonight: what the code will do, and what to do about it

### 2a. The timeline as the workflows are configured (all times ET, Sept 28 to 29)

| When | What fires | Effect on School Girls |
|---|---|---|
| ~8:30 to 9:30 AM | `update-show-status` (08:00 UTC cron, fires 4 to 5 h late) | Flips status previews to open. Auto-fires **Opening Night Express** for the show. |
| ~9:30 to 10:15 AM | Express auto-fire | Cancels any running orchestrator/poller, gathers (nothing published yet), scores nothing, queues a **retry 16 h later** (~2 AM), releases. |
| 5:00 PM | Headless monitor window opens (launchd, every 20 min, Opus, $200/night cap) | Runs one 15-minute pass per tick if the Mac's `claude` auth and `.env` are healthy. |
| 7:00 PM cron → fires ~8:50 to 9:25 PM | `opening-night-orchestrator` (Broadway) | Selects 44 shows; dispatches a multi-show poller (its own filter yields 35) for pass 1 with SERP off. School Girls is second in the list, so it is visited two to four minutes into the pass, probably before the embargo. |
| ~9:30 to 10:30 PM | Reviews and the BWW Review Roundup publish | The 5-minute watcher may or may not tick; if it does, it skips dispatch because an auto poller is running. |
| ~10:45 to 11:15 PM | Poller pass 2 | Finds the roundup, creates files, then keeps going through the other 34 shows (55 to 90 min). |
| ~12:30 to 1:30 AM | End of pass 2: inline scoring (10-min cap), rebuild, push, deploy, 9-min live check | **First batch live.** |
| ~12:30 to 3:00 AM | `enrich-reviews` (04:30 UTC) and `rebuild-reviews` (04:00 UTC), both usually late | LLM wrong-production and non-review classifiers run over the new files. This is where the director bug bites. |
| ~1:00 to 1:20 AM | Orchestrator 240-minute deadline | Loop exits; pass 3 runs only if it started before the deadline. |
| ~2:00 to 8:00 AM | Express retry (due 16 h after the morning run; dispatched by a checker that is scheduled hourly but has fired every 2 to 6 hours this week) | Cancels in-flight pollers, runs a single-show gather → collect → score → rebuild → deploy. |
| ~5:45 to 6:30 AM | Morning orchestrator | Another multi-show pass. |
| 8:30 AM | Broadcast preview/draft | Only if 8+ scored reviews, checklist clean, Critics' Take present. |

Best case: first reviews live about 2.5 hours after publication; stragglers at 5:45 AM and later. On Paranormal Activity (section 3) the reviews were discovered 19 minutes after they appeared and scored at 42 minutes, and still took 121 minutes to reach the site; 20 reviews took 189 minutes. Note also that the Paranormal Activity reviews appeared around 9:00 PM, not 10 PM, which is before tonight's first poller pass is likely to start.

### 2b. Risks specific to this show

| Risk | Evidence | What to do |
|---|---|---|
| Wrong director in shows.json (Taichman instead of Whitney White) | Playbill/Wikipedia vs `data/shows.json` creativeTeam. `review-guards.js:167` `hasNamedDifferentDirectorSignal` vetoes the in-window override when the review names a director not on the show. | Edit the private `shows.json` today (git pull first, commit, push). |
| Pre-opening files exist for the show | `data/audit/poller-backoff/<show>.json` shows `lastNewReviewAt 2026-08-21`. reviews.json has 0 rows, so they are excluded, but a flagged file occupies the outlet slot and can swallow tonight's real review (the "slot squatting" class, BRO-2784) or carry stale flags onto it. | List `~/broadway-review-texts/school-girls-or-the-african-mean-girls-play-2026/`; for any 2017 URL: `git rm` it and add the URL to the poller blocklist (`node scripts/block-review.js`). Do not merely flag. |
| Revival with a same-title 2017 production that many of tonight's critics also reviewed | The wrong-production classifier is 44% false-positive on opening nights per the monitor's own notes; the 2017 production is not in shows.json, so there is no sibling to route 2017 reviews to. | After the director fix the in-window override should hold. Check at ~1 AM for `wrongProduction` stamps on the show's files and clear with all 8 protection fields. |
| Reviews mislabeled as "preview" non-reviews | BRO-4189 (P1, Backlog): 106 files on 130 recent shows excluded by the content-verification "preview article" label, including NYT and TheaterMania files. Once flagged they are never scored, so the corroboration that could clear them never appears. | Same 1 AM check for `isNonReview`. |
| Headline-mismatch backstop hides real reviews | BRO-4058 (In Progress): 45 real reviews hidden because the page `<title>` does not contain the show name. This title is long and punny headlines are likely. | Same check: `incompleteReason: url_content_mismatch`. |
| Bare "paywall" keyword marks text as garbage | BRO-4124 (In Progress). | `unscoredSkipReason` check per the memory note. |
| The watcher is starved and self-suppressed | 40 runs in 6.25 days; `watch-aggregator-urls.js:272-295` skips when any "— auto" poller is active. | Dispatch targeted pollers by hand (2c). |
| Deploy gate misses some data-only changes | Since BRO-3149 the 5-minute deploy gate compares the private repo's `reviews.json` and `shows.json` blob SHAs against the live deployment, so a rebuild that lands only those files now deploys within ~10 to 15 min (when the token lookup works; it fails open). Any other core-data file, and any failure of that lookup, still rides the 6 h backstop. | If prod does not move 20 min after a rebuild commit: `gh workflow run vercel-deploy.yml  # FORCE-DEPLOY`. |
| The watcher's own dispatch takes the slow path | `watch-aggregator-urls.js:289-291` dispatches the targeted poller without `fast_path`, so even a successful watcher dispatch goes through `rebuild-reviews.yml` (queued on a shared group, ~45 to 95 min) instead of the inline rebuild. | The manual loop in 2c passes `fast_path=true`. |
| Scores and texts that exist only on the runner | In the poller, the "Commit collected texts" and "Commit scores" pushes to the private repo are `continue-on-error`. If a push loses its retries, the inline rebuild still publishes the score (it reads the runner's copy), and the next full rebuild from a fresh clone drops it. This is the "went live, then vanished" shape from Paranormal Activity. The stage verifier ignores commit-step outcomes (`opening-night-poller.yml:956-961`). | If a review disappears from prod between checks, look for a failed push step in the last poller run before re-ingesting anything. |
| Monitor not actually running | BRO-4141: auth preflight failed 3x/day Sept 14 to 25; fixed Sept 25, card still In Review. Aug 26 passes ran without `.env`. | `launchctl list \| grep opening-night-monitor`; `node scripts/opening-night-monitor-launch.js --dry-run`; `node scripts/check-claude-auth-health.js`. |
| Express retry cancels pollers mid-run | `opening-night-express.yml:169-187` and `373-386` cancel all in-progress orchestrator/poller runs. A poller killed before its "Commit new review files" step loses that pass's discoveries. Express then re-gathers, so the loss is usually recovered, later. | Accept for tonight. In the lane design this goes away. |
| Nothing pages you if discovery fails outright | The SLA alerts are per in-flight review (a review must be seen first); the 30-minute drift check compares stage counts (all zeros is "no drift"); the poller's "LOW COVERAGE" line is a log annotation after 24 h. The first human-visible signal of a dead night is the 8:30 AM broadcast-blocked email. | Check the live JSON yourself at ~11:30 PM and ~1 AM, or run the targeted-poller loop in 2c, which prints its own results. |

### 2c. Playbook for today and tonight (owner plus one local Claude session)

**Today (before 8 PM ET), in a local session that has `.env` and the private repos:**

1. Fix the director in the private `shows.json` (`~/broadway-scorecard-data/shows.json`): pull, set creativeTeam director to Whitney White, keep Jocelyn Bioh, commit, push. Then `node scripts/validate-data.js`.
2. Inspect the show's review-texts directory in `~/broadway-review-texts/`. For every file, read `url` and `publishDate`. 2017 reviews: `git rm` and blocklist the URL. 2026 preview-period features: leave them; the poller marks unscored pre-opening files as placeholders and replaces them.
3. Confirm the monitor is armed: plist loaded, no `data/opening-night-monitor/DISABLED`, `--dry-run` shows the show in window from 5 PM, auth health passes, `.env` has scraper keys.
4. Run the cloud-safe readiness check (it passed 11, warned 6, failed 0 this morning) plus the two checks it could not run from the cloud: ScrapingBee credits (`node scripts/lib/check-sb-credits.js`) and the Bright Data zone.
5. Leave `EXPRESS_AUTOFIRE_DISABLED` and `ORCHESTRATOR_PAUSED` alone. Changing them tonight adds failure modes.

**Tonight (from ~9:15 PM ET), the one action that actually shortens time-to-live:**

6. Run a targeted-poller loop from the Mac. Every 20 minutes until ~2 AM:
   ```bash
   gh workflow run opening-night-poller.yml \
     -f show_id=school-girls-or-the-african-mean-girls-play-2026 \
     -f fast_path=true -f skip_serp=true
   ```
   A targeted poller has its own concurrency group, so it does not wait behind the 44-show pass, and it does the full inline collect → score → rebuild → deploy → live-check for this one show in roughly 15 to 25 minutes. This is exactly what the watcher would do if it were not starved and self-suppressed. When the BWW roundup URL is known, add `-f bww_roundup_url=<url>`. Queued duplicates are harmless (the group queues one).
7. After each pass: `node scripts/verify-review-recovery.js --show=school-girls-or-the-african-mean-girls-play-2026 --production` and the live JSON (`https://broadwayscorecard.com/data/shows/school-girls-or-the-african-mean-girls-play-2026.json?cb=<now>`, fields `rc`, `cs`, `rv`).
8. At ~1 AM and again at ~7 AM: grep the show's files for `wrongProduction`, `isNonReview`, `incompleteReason`, `rejectionReason`; clear only with venue/date corroboration and all 8 protection fields; then one rebuild via a targeted poller, not `rebuild-reviews.yml`.
9. Do not: dispatch `rebuild-reviews.yml` by hand (pollers cancel it); re-ingest anything already on `origin/main`; `git reset --hard` plus rsync; edit `data/review-texts/` in the web repo (gitignored, invisible to CI).

---

## 3. How the last Broadway opening went: Paranormal Activity, Aug 25

Final state today: 35 rows in reviews.json (20 dated Aug 25, 7 dated Aug 26, the rest stragglers through Sept 4), composite 77.12. The site got there, but not autonomously and not within an hour.

**The night, reconstructed from the GitHub Actions run history** (500 runs and their logs in the 30-hour window; all times ET, Aug 25 to 26). The pipeline's own latency ledger has no discovery, collection or deploy events for the show that night, so this came from run logs and the review count in the public show file at each commit.

| When | What happened |
|---|---|
| ~9:00 PM | Reviews and the BWW roundup publish. The 8:08 PM poll found nothing; the 9:11 PM poll found a roundup listing 24 reviews. (Not 10 PM as usually assumed.) |
| 9:09 to 9:19 PM | Poller pass 2 discovers 16 reviews (NYT, Variety, Vulture, EW, Daily News, NY Post, TheaterMania, Time Out, Theatrely, Culture Sauce, Exeunt, NYSR x2, Cititour). Discovery worked, 19 minutes after publication. |
| 9:33 PM | The 16 review files are committed to the private repo (+33 min). |
| 9:41 PM | Full text collected for 13 of them (+41 min). The push is lost: `push-with-retry.sh` crashes with `restore_head_if_moved: command not found` after finding a stale rebase state left by an earlier crashed run. |
| 9:42 PM | 12 reviews scored by the ensemble (+42 min). The push is lost the same way. |
| 9:45 PM | The same run's inline rebuild is killed by the poller's 60-minute job timeout. Its checkout alone had taken 21 minutes (`fetch-depth: 0`, which is required after an earlier incident). |
| 10:01 PM | Poller pass 3 starts, spends 26 minutes checking out, finds the DTLI page and 22 more files, and is killed at 60 minutes before collecting text. |
| 10:05 to 10:58 PM | Six of seven rebuild-fast runs fail at "Commit and push": main and the data repo were taking a commit roughly every minute. A separate scoring run re-scores the 12 reviews at 10:28 PM. |
| 10:53 PM | A West End orchestrator's poller runs its own inline rebuild and happens to carry the 12 scored Paranormal Activity reviews. |
| 11:01 PM | First 12 reviews live on the site (+121 min). |
| 12:09 AM | 20 reviews live (+189 min). 21 at 1:31 AM. |
| 12:44 to 1:00 AM | The owner's local session ships four code fixes to main mid-night (Talkin' Broadway extractor, roundup-page detection, the Express same-night retry). |
| 8:26 to 9:51 AM | Three broadcast runs blocked by "checklist gate: QA errors". The owner runs the checklist by hand at 8:37; a session baselines the roundup contradictions at 10:59. |
| 1:00 to 1:51 PM | The owner dispatches the broadcast three times (two fail on a state push) and sends the Resend draft by hand at 1:51 PM, about 17 hours after the reviews. |
| 2:24 PM | Sandy MacDonald's Substack review, filed as Vulture and blocked, is hand-fixed. |
| 6:24 PM | A manual Express run for a different show cancels the live West End orchestrator and its poller. |

Where the first 121 minutes went: 9 to 19 minutes waiting for the pass to reach the show; 23 minutes for discovery, commit, text and scoring, which all worked; 71 minutes lost to the job timeout, the push crash and the push storm; 8 minutes for the deploy, which worked as designed. The Broadway path never published anything itself that night; a West End run did it by accident.

Run tallies for the 30-hour window: pollers 10 cancelled, 1 failed, 8 succeeded (every cancellation was the 60-minute timeout after a 21 to 26 minute checkout; the timeout is 100 minutes today and passes still run 54 to 94 minutes); rebuild-fast 29 succeeded, 68 failed, 9 cancelled (67 of the failures at the push step); rebuild-reviews 10 succeeded, 28 failed, 14 cancelled; the hourly checklist failed 17 times at "Commit audit data", so its SLA state never persisted; the watcher saw the BWW roundup at 9:45 PM and the DTLI page at 10:53 PM and dispatched nothing both times (the suppression in 2b, observed live); Express auto-fired at 5:09 AM on the morning of the opening, 17 hours early, created 7 pre-opening files and failed on its push. The orchestrator finished 4 of 10 iterations and the SERP arm never ran.

**What the ledgers show**

- `data/audit/stage-latency.jsonl`: the first "rebuilt" event for the show is at 1:44 AM ET with 21 reviews. NYT (Helen Shaw) was not scored until 4 PM ET the day after, and was re-scored at 7:35 PM. The review count moves 21 → 22 → 21 → 20 → 21 → 22 → 21 → 22 over Aug 26: reviews found, dropped by a guard, restored by hand.
- `data/audit/opening-night-latency-2026-08-25.json` reports `median_e2e_ms: null` for every show. The latency instrumentation cannot compute the number it exists to compute.

**What went wrong in the data (from Linear and the monitor's own notes, all filed Aug 25 to 26)**

| Failure | Where it is written down | Status now |
|---|---|---|
| "Six of eight auto pollers cancelled": the run logs show these were 60-minute job timeouts after 21 to 26 minute checkouts, not concurrency cancels; either way a 5-hour discovery dead zone | BRO-2358 | **Backlog, untouched since Aug 26**; the timeout was raised to 100 min, the checkout cost was not addressed |
| Express fired at the morning status flip, found nothing, never retried | BRO-2402; retry mechanism added later (card #1889) | Retry exists; fires 16 h later, after the wave |
| Express failed with a critical alert; owner had to triage the morning email pile | BRO-2325 | In Progress |
| NYT review dropped off the live site hours after opening: the ensemble "scoreability" check rejected the paywall stub as "not a review" even though its score came from a DTLI thumb | silent-gates catalog, Aug 26 | BRO-2495 |
| TheaterMania review went live, then vanished when its full text arrived: the tour-contamination guard read "following a national tour" in the intro | catalog, Aug 26 | P0 card filed; the guard still inspects only the first 600 characters (`review-guards.js:3620`) |
| Two phantom reviews (a critic's personal repost blog; the DTLI show page ingested as a review) and two same-URL byline/unknown pairs inflated the count | catalog, Aug 26; BRO-2403 | Backlog |
| Chris Jones counted twice (Tribune + Daily News), then lost entirely when dedupe picked the copy a later gate excluded | catalog, Aug 26 | P1 card, parked |
| Sandy MacDonald's Substack review filed as Vulture (tier 1) because outlet was resolved by critic name, then blocked by the domain guard | BRO-2459 | Backlog |
| The headless monitor ran without `.env`, so every fetch in its independent census failed all night | catalog, Aug 26 | Fixed in launcher |
| Local `fetchPage` silently skipped every paid scraper tier (no dotenv) | catalog, Aug 26 | Card filed |

The pattern is the point: discovery worked; publication did not. Reviews were found within 20 minutes, then lost to push failures, timeouts and guards written for the 20,000-review corpus, then restored by a human or a Claude pass, then lost again. Full run-by-run detail: `scratchpad/pa-timeline.md` from this session (500 runs, 1,193 lines).

---

## 4. The pattern across every post-mortem since March

Sources: Giant (Mar 23, Notion incident page), Becky Shaw (Apr 6), Cats (Apr 7, 17 issues), Death of a Salesman (Apr 9, 22 issues), Rocky Horror (Apr 23, 22 issues), Joe Turner (Apr 25, ~42 issues), Beaches, Lost Boys, Paranormal Activity (Aug 25), and the September West End and Off-Broadway nights the monitor worked (Jane Eyre, Kimberly Akimbo, Man to Man, Catarina, The Last Ship). A separate pass over 63 memory files found manual intervention recorded on Giant, Dog Day Afternoon, Cats, Schmigadoon, KENREX and Jesus Christ Superstar as well, so with the post-mortems above the count of openings that needed a human is at least fifteen since March.

| Class | What it looks like | Nights it hit | Representative fixes | Why it keeps coming back |
|---|---|---|---|---|
| **A. Timing on the wrong substrate** | Crons 1 to 5 h late; SERP arm at iteration 9 never reached; 5-min watcher runs every ~4 h; multi-show pass visits the show once an hour | Kinky Boots, Cats, Joe Turner, PA, tonight | Crons shifted 2 h earlier; iteration cap 16 → 10; 240-min deadline; launchd backup trigger | GitHub Actions cron has no latency guarantee, and every fast path is a cron. |
| **B. Concurrent writers to two shared repos** | `pull --rebase -X theirs` drops fields; push storms; 30 s transport hangs; API fallback refuses `reviews.json`; rebuild-fast fails 4 to 5 times in a row | Cats (#5, #9, #15, #16, #17), DoaS (#5, #21), Joe Turner (#7, #21), PA, Sept 4/10/12 | PROTECTED_FIELDS (now 116), `_locked`, restore-protected-fields, per-show concurrency groups, watcher idempotency, push mutex, Git Data API fallback | The fix for one race (watcher idempotency) created the latency problem in A. 122 workflows still push to the two private repos; BRO-2269 (poller vs gather-reviews race) is parked. |
| **C. Silent gates that hide correct reviews** | wrongProduction (44% FP on opening nights), isNonReview "preview" (106 files), headline mismatch (45), `scraper_garbage` hard reject, tour and cross-market guards, slot squatting, dedupe survivor excluded, syndication, paywall stubs rejected, roundup-URL swap wiping scores | Every night since Cats | Overrides, 8 protection fields, in-window guards, manual clears | Each guard protects the corpus; none knows tonight's show is the one that matters. The catalog grew by 26 classes in August and 56 in September. |
| **D. Deploy blindness** | Green deploy run that deployed nothing (content gate ignored private data until BRO-3149 landed); one unrelated show's bad row blocks every deploy (BRO-4099); rebuild-fast never staged public files (DoaS #1); the poller cancels any rebuild-fast or rebuild-reviews run in flight, so another show's scored data waits up to 4 h; Express cancels a running scoring job and its un-pushed scores | DoaS, Sept 10, 12, 24 (The Last Ship) | explicit-ship path, blob-SHA data check in the gate, poller "wait for live" step, FORCE-DEPLOY lever | Every workflow still assumes it is the only writer; the cancels are the coordination. |
| **E. Observability that lies** | "Updated:" printed while nothing persisted; checklist drift check reads a field never written (BRO-4048); checklist crashed silently for 3 months (missing `npm ci`); latency medians null; history ledger silent Apr 26 to Aug; the "scored but not live" detector logs but never emails (`verify-opening-night-live.js:151-160`); the cron-health list omits the watcher, rebuild-fast, the completeness check and the deploy cron, so any of them can stop without a page | Continuous | Exit-code discrimination, telemetry commits | Green means "the step ran", not "the review is live". |
| **F. The fixer is nondeterministic** | Headless monitor passes: 12 passes chasing deploy lag as missed discovery (BRO-3153), 3 passes editing the wrong private repo, 27+ passes on PA, $146 nights | Aug 12 onward | Prompt v2, triage tool, ledgers | A fresh Claude pass every 20 minutes rediscovers the system from a prompt and a memory file. It cannot hold 67 gate classes and 116 protected fields. |

**"Fixed", then it came back.** A catalog pass over 63 memory files (the full list is in the session's memory-catalog report; contradictions below are dated from the files themselves):

1. The April 2 reliability plan declared "opening night review gathering fixed". Cats failed five days later with 17 issues.
2. Aggregator stars written into an outlet's own score: "all fixed 2026-04-06"; the same file's Apr 10 update says it kept appearing, and the roadmap cleared 3 more files on Apr 10 and 10 more on Apr 11. Root cause never found.
3. WET wrong-show ingestion: fixed Apr 8 and hardened Apr 10/11; on Jul 7 a title check that always matched put five Hello, Dolly! reviews on Jesus Christ Superstar.
4. ScrapingBee budget: "fits the 1M budget" (Mar 12), "85% SERP savings" (Mar 25); the full 2M monthly credits were burned by Jul 5 and exhausted again Jul 21.
5. The `_pending` no-byline strand: fixed Apr 19 and Apr 22; on Jun 4, 511 reviews across 72 shows were found stranded because the collector never scanned `_pending`.
6. The URL slug guard: fixed for Talkin' Broadway Apr 19; on Jun 5 the same guard was found to have dropped the FT on every opening since.
7. The BWW roundup validator: hardened Apr 15; accepted a tryout roundup Apr 20; picked up prior-run roundups (2022 Gielgud for a 2026 show) Jul 11. The "reject roundups more than 6 months before opening" to-do is not marked done anywhere.
8. TLS/CI blocking: "fixed both scrapers" Mar 24; the BWW roundup scraper still used raw `https.get` Apr 20; BWW blocked CI IPs by a different mechanism Jul 21.
9. Outlet-domain misattribution: "rejected at creation time from all sources" Mar 20; Cats Apr 10 (a Guardian URL filed as Observer); Proof Apr 19 (an NYSR URL filed as WSJ); Paranormal Activity Aug 25 (a Substack filed as Vulture).
10. Push races: "tested with concurrent runs" Mar 17; scores dropped Apr 7; a cleared field restored Apr 25; runs auto-cancelled by contention Jul 22; five consecutive rebuild-fast push failures Sept 12.

Same shape in the workflow layer: the Joe Turner log lists the poller cancel cascade as fixed with the `any_action` gate; the same cascade produced the Paranormal Activity dead zone in August (BRO-2358). Express was built to eliminate the concurrent-CI race; it now cancels the pollers and is itself timed for the wrong hour. The watcher idempotency check was added to stop a push storm; it now stops the fast path.

---

## 5. Why "all errors are fixed" never holds

1. **Wrong substrate.** GitHub Actions cron plus git pushes to shared repos is a batch system. Sub-hour, single-show, real-time work needs a process that is already running when the embargo lifts and polls every couple of minutes without a scheduler in the loop. The orchestrator already imitates this (one long job with an internal loop), but it does it for 44 shows at once.

2. **Wrong topology.** One general pipeline serves 2,800 shows, backfills, and opening night. Every corpus guard (wrong production, non-review, garbage text, syndication, tour contamination, cross-market, roundup detection) is a loss vector for the one show whose reviews were, by construction, published tonight about this production. The writers are not coordinated: 64 workflows push to the review-texts repo and 82 push to the core-data repo (122 distinct workflows), and 132 scripts write review files. On the night itself that means two orchestrator crons, pollers (auto and targeted), Express and its retry, gather-reviews via opening-night-reviews, the watcher, enrich-reviews, rebuild-reviews, rebuild-fast, fetch-guardian, the Show Score refresh, the admin ingest UI, the headless monitor, and the owner, all rebasing onto each other.

3. **Wrong feedback loop.** Each incident produces guards, protected fields, memory notes and Linear cards, never fewer paths. The Sept 25 to 27 cards alone add: outlet-listing poller misses most reviews (BRO-4185), isNonReview preview mislabel (BRO-4189), headline backstop (BRO-4058), paywall keyword (BRO-4124), roundup URL swap (BRO-4128), score fields dropped on merge (BRO-4042). A session that fixes three of these and reports "fixed" is telling the truth about three of them. Nobody can verify the composition, because there is no rehearsal: `simulate-opening-night-full.sh` exists but is referenced only in a lint allowlist, and it needs live emails and live scraping.

4. **No single place to see the night, and no alarm for silence.** Stage latency lives in a 300,000-line JSONL with null medians, the checklist history stores only counts, the express completion record counts a field that reviews.json rows may not carry, and the deploy state lives in Vercel. Every alert is keyed to a review the pipeline already saw, so a night where discovery finds nothing is indistinguishable from a quiet night until the morning broadcast gate complains. Diagnosis on the night is archaeology across ledgers, which is what the monitor spends its passes on.

---

## 6. What to build instead: the opening-night lane

One show, one night, one process, one writer, one ledger, one verification. About 1,500 to 2,500 lines, mostly reusing existing libraries (BWW roundup discovery, DTLI, Show Score and Playbill Verdict extractors, `fetchPage`, the ensemble scorer, the review-file writer). Two to three weeks including the rehearsal harness.

**Trigger and lifetime.** Arm at curtain time (openingDate 17:00 ET for Broadway) and run as one process until 14 hours later, with an internal 2-minute loop. Start it two ways so a late cron cannot matter: a GitHub Actions job scheduled two hours early that sleeps until curtain, and the existing Mac launchd backup trigger at the exact time. Whichever starts first takes the night lease; the other exits.

**Discovery every 2 minutes, cheap first.** BWW homepage and Review Roundup, DTLI homepage and sitemap, Show Score, Playbill Verdict, Google News RSS for the title, the outlet RSS feeds, Talkin' Broadway direct URL, and plain-curl sweeps of the T1 outlet section indexes (the Sept nights proved index pages beat search for paywalled outlets). SERP only after +3 h and only for T1/T2 outlets still missing.

**Trust model for the night.** Any URL cited by an aggregator for this show, or found on an outlet's own index with a publish date on opening night ±1 day, is written with provenance `openingNightLane: {show, night, source, seenAt}` and `productionVerified: "aggregator"`. For those files the corpus guards are off: no wrong-production classifier, no non-review classifier, no headline backstop, no scraper-garbage reject, no tour or cross-market guard, no roundup-URL swap. Slot collisions create a new file (outlet + critic + night) instead of merging into a flagged one. A paywalled T1 whose text cannot be fetched is scored from the aggregator thumb or stars plus excerpt at low confidence and queued for re-collection, never rejected.

**Text and scoring inline, per review.** Fetch, extract, score with the ensemble immediately as each URL arrives (not in a batch after the 44th show). Target: URL seen to scored in under 5 minutes.

**A checkout that does not eat the budget.** The Paranormal Activity pollers spent 21 to 26 minutes of a 60-minute job on `fetch-depth: 0` checkouts of a repository that receives a commit a minute. The lane clones only what it needs (the show's review-texts directory, `shows.json`, `reviews.json`) with shallow, sparse checkouts, and never full history.

**Publish with a single writer.** The lane holds a per-show night lease (`data/opening-night/leases.json`). While it holds it: the orchestrator's poller, Express, gather-reviews, enrich-reviews, rebuild-reviews and rebuild-fast skip this show's directory, and `push-review-texts` refuses writes to it from any other workflow. The lane writes the show's rows into reviews.json by key (never a whole-file rewrite from a stale snapshot), pushes, regenerates only this show's public JSON, ships an explicit deploy, and polls the cache-busted live JSON until each review's URL is present. Every state change goes into one append-only ledger per night: discovered → fetched → scored → rebuilt → deployed → verified-live, each with a timestamp. Time-to-live per review is the KPI, computed from that ledger, not from stage-latency.jsonl.

**Reporting.** One status page fed by the ledger, one email at parity (every aggregator-cited review live) or at window end (with exactly what is missing and why). No Discord warnings, no per-fix narration.

**Rehearsal, and refusing to arm without it.** Record the aggregator pages, outlet index pages and review HTML from a real opening (Paranormal Activity is a good corpus: 35 reviews, a paywalled NYT, a syndicated Chris Jones, a Substack critic) into a fixture set. `lane --rehearse` replays them through the full path against a staging show id, including the deploy step in dry-run and the live-check against a local static server. Run it weekly in CI and at T-24 h before every real opening. If the last rehearsal failed, the lane pages the owner and does not arm; the old pipeline runs unchanged that night. This is the mechanism that ends the Groundhog Day loop: the composition gets tested before the night, not during it.

**The manual path stays, inside the lane.** The `/admin/ingest` UI keeps working; during a night its writes go through the lane's writer so they get the same provenance, the same deploy, and the same ledger line.

**What the monitor becomes.** Not the guarantee. A reviewer that reads the ledger and the live JSON at window end and writes the report. If the lane needs a Claude pass to work, the lane is not done.

### What to stop doing on opening nights (once the lane is armed)

- Multi-show orchestrator passes for the opening show (it keeps running for everything else).
- Express auto-fire at the morning status flip and its 16-hour retry.
- The 5-minute watcher (its job moves into the lane's 2-minute loop).
- `opening-night-reviews.yml` gather dispatches for the show.
- `enrich-reviews` classifiers and `rebuild-reviews` flaggers touching the show's directory for 48 hours.

### Sequencing

1. Week 1: lane core (discovery loop, trust-model writer, inline scoring, night lease honored by push-review-texts and the six workflows above), plus the ledger and status page.
2. Week 2: publish path (merge-by-key into reviews.json, single-show public JSON, explicit deploy, live verification), then the rehearsal fixture from Paranormal Activity and the `--rehearse` mode in CI.
3. Week 3: shadow run on the next Broadway opening (Other Desert Cities, Oct 18) with the old pipeline still live; compare ledgers; then arm for Billy Crystal 860 (Oct 21), The Imaginary Invalid (Oct 22), A Few Good Men (Oct 29).

This is deliberately not a rewrite of gather/collect/rebuild. Those stay for the corpus. The lane is a narrow, testable path for the one night that matters, and the first opening-night code in this repo that can be proven to work before it is needed.

---

## Appendix A: Evidence

- Opening date: Playbill production page ("Opening Night: Sep 28 2026"); BroadwayWorld article 20260927 ("ahead on opening night, September 28"); `data/shows.json` openingDate 2026-09-28, status previews, isRevival true.
- Director: Playbill and Wikipedia credit Whitney White for 2026; Rebecca Taichman for MCC 2017. `data/shows.json` creativeTeam lists Taichman. Veto logic: `scripts/lib/review-guards.js:167-192`; override: `scripts/classify-wrong-production.js:436-465`; window: `review-guards.js:271-290` (21 days lead, 30 days lag after the later of opening/closing).
- Selection: `node scripts/lib/opening-night-selection.js --market=broadway` returned 44 ids this morning, School Girls second.
- Orchestrator: `.github/workflows/opening-night-orchestrator.yml` lines 28-34 (crons), 452-468 (10 iterations, 15-min sleep), 541-565 (240-min deadline and the note that iterations 9-10 are the only SERP-enabled ones), 610-625 (SERP deferral). Recent scheduled fires: 2026-09-28T01:21Z, 09-27T01:03Z, 09-26T01:08Z.
- Poller pass durations (run id: minutes): 36371496344: 94; 36365762245: 94; 36365026049: 70; 36360665564: 54; 36356171795: 65; 36350787846: 78. Per-show loop and gates: `opening-night-poller.yml:302-375`; inline scoring cap `:633`; concurrency groups `:71-88`.
- Watcher: 40 scheduled runs between 2026-09-22T00:53Z and 2026-09-28T07:04Z for a `*/5` schedule. Suppression: `scripts/watch-aggregator-urls.js:272-295`, `scripts/lib/poller-idempotency.js` (`findInFlightAutoPoller`).
- Express: `opening-night-express.yml:106-187` (lease + cancel), `:314-332` (retry evaluation), `:373-386` (re-cancel after scoring); retry queue `data/audit/express-retry-queue.json` (dueAt = queuedAt + 16 h, attempted 2 to 2.5 h after due). Auto-fire runs: 2026-09-25T13:58Z, 09-26T13:23Z, 09-27T14:13Z. The "hourly" retry checker (`opening-night-express-retry-check.yml`, cron `50 * * * *`) fired at 22:12Z, 00:56Z, 07:07Z, 13:19Z, 17:56Z, 21:38Z, 23:59Z and 05:55Z between Sept 26 and 28.
- Poller visit order for a Broadway auto pass tonight (the poller's own filter, lookback 21): 35 shows, School Girls at index 1.
- update-show-status: cron 08:00 UTC, actual starts 12:30 to 13:20 UTC on Sept 24 to 27; `isDateReached` at `scripts/update-show-status.js:107`.
- Paranormal Activity: run-history reconstruction in `scratchpad/pa-timeline.md` (key runs: poller 32916323189 discovered the roundup at 01:09Z and lost its text/score pushes at 01:41Z and 01:43Z, rebuild cancelled 01:45:23Z; WE poller 32922145429 pushed the first rebuild with the reviews at 02:53:51Z, commit c4ab25af; deploy 32924430760 aliased 03:01:25Z; deploy 32928713126 with 20 reviews aliased 04:09:05Z; Express 32830432127 fired 09:09Z Aug 25 and failed at push); `data/audit/stage-latency.jsonl` lines for `paranormal-activity-2026`; Linear BRO-2358, BRO-2402, BRO-2325, BRO-2403, BRO-2459; `cloud-memory/feedback_discovery_pipeline_silent_gates.md` entries dated 2026-08-25/26.
- Complexity: 247 workflow files, 61,545 YAML lines; `gather-reviews.js` + `collect-review-texts.js` + `rebuild-all-reviews.js` + `opening-night-poller.js` = 21,855 lines; `PROTECTED_FIELDS` length 116 (`scripts/lib/review-write-guard.js`); 67 `##` gate headings in the silent-gates catalog (dates: 2 in June, 26 in August, 56 in September); 97 Linear issues created since Aug 20, 32 mentioning opening night.
- Monitor: `scripts/opening-night-monitor-launch.js` (NIGHTLY_USD_CAP 200, HEADLESS_MAX_WALL_MIN 15, model opus), `scripts/opening-night-prompts/monitor-v2.md`, `scripts/launchd/com.bwsc.opening-night-monitor.plist` (StartInterval 1200); BRO-4141; catalog entries 2026-08-26 (no `.env`), BRO-3153 (12 passes on deploy lag).
- Readiness this morning: `node scripts/check-opening-night-readiness.js --show=school-girls-or-the-african-mean-girls-play-2026`: 11 pass, 6 warn (DTLI slug, Talkin' Broadway URL, 4 keys absent in the cloud sandbox), 0 fail.
- Workflow graph (from the session's workflow-graph report, `scratchpad/workflow-graph.md`): discovery to live needs 2 GitHub runs on the poller fast path (typical 35 to 60 min from the start of a single-show poller run, up to ~92 min by step budgets) and 3 runs on the legacy path (45 to 95 min); the day-0 aggregator path without Express or orchestrator takes 6 to 7 runs and 3 to 8 h. Concurrency: every group holds one running plus one pending run, and a new arrival cancels the older pending run even with `cancel-in-progress: false`; cancelled runs never alert. Conflict rule in `push-review-texts` (`action.yml:317-368`): on a rebase conflict the version with the shorter `fullText` loses, so a scored shorter copy can lose to an unscored longer one. 31 distinct places a review can be dropped without an alert are enumerated in that report.

## Appendix B: Linear follow-ups

Filed today from this review (BRO-4207):

- **BRO-4208** (P0 data, today): fix the School Girls creative team (Whitney White); audit the show's Aug 21 files in review-texts.
- **BRO-4209** (P0): the watcher's auto-poller idempotency skip suppresses the fast path every night, its `*/5` cron fires every ~3.7 h, and when it does dispatch it omits `fast_path`, so its poller takes the slow rebuild-reviews route; either fix all three or retire the watcher into the lane.
- **BRO-4210** (Epic): the opening-night lane (section 6), with the rehearsal harness as the first acceptance criterion.

Existing cards that should move before the next Broadway opening:

- BRO-2358 (poller cancel cascade): in Backlog since Aug 26; it describes exactly the dead zone that will recur.
- BRO-2269 (poller vs gather-reviews race on review-texts and core data): parked.
- BRO-4189 (isNonReview "preview" mislabel), BRO-4058 (headline backstop), BRO-4124 (paywall keyword): P1 today, each one hides correct reviews on the night.
- BRO-3149 / BRO-3189 (deploy gate blind to private-data commits).
- BRO-4048 (checklist drift check reads a field that is never written).
