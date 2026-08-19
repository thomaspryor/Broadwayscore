---
name: feedback_discovery_pipeline_silent_gates
description: "Review discovery has independent silent gates keyed off openingDate/title/byline; a show \"with no reviews\" usually means a gate dropped them, not that scrapers failed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dab9e266-2c1f-4178-9dc7-ce1d9fd541d8
---

When a show has missing reviews that are trivially Googleable, the scrapers are almost never the cause — a **gate** silently dropped the show or its reviews. 2026-06-15: "A Life in Four Seasons" (2/7) and "Are You Now Or Have You Ever Been?" (0/3) exposed three distinct gates, all now fixed.

**Why:** the pipeline is discover → collect text → score → rebuild, and EACH stage has filters that fail independently and silently. Diagnose by walking the stages, not by re-running scrapers.

**How to apply — check these gates in order when reviews are missing:**
1. **Did the dedicated poller even run?** `opening-night-orchestrator.yml` selection excluded WE shows with untrusted `openingDateSource` (todaytix) and ANY show with null `openingDate` (`if(!s.openingDate) return false`). OB/OWE open "cold" with null openingDate → invisible. Fix shipped: WE untrusted-source polls once `status==='open'`; OB/OWE fall back to `previewsStartDate`. If a show isn't in the orchestrator's poll list, the 5-aggregator + SERP + site-search breadth never ran.
2. **SERP outlet gate** (`gather-reviews.js` ~L4605): for WE shows only `region==='london'`/dual outlets are searched. A UK outlet missing `region` in `outlet-registry.json` is silently skipped (plays-to-see/theatre-vibe). Dual-repo: fix public + `~/broadway-scorecard-data`.
3. **url_content_mismatch FP on long titles** (`content-quality.js validateContentMentionsShow`): required title ≥3× in body; a 7-word title never repeats and a trailing "?" breaks matching. Fix: guarded headline-lead `<title>` signal + body long-phrase threshold-lowering. Long titles live in the headline, not body prose.
4. **The scorer reads reviews.json, not review-texts.** A new prose review with no aggregator star/percent score must be put into reviews.json by a **rebuild first** (shows as "awaiting"), THEN the LLM scorer finds it. Sequence to surface a recovered prose review: rebuild → score → rebuild → deploy. Skipping the first rebuild = scorer scores 0.
5. **Multi-critic outlet + unknown byline** → `_pending` no-byline strand, excluded. Set the outlet as criticName (e.g. "The Stage") like thereviewshub does, or find the byline.

**More gates/classes (2026-06-22):**
6. **Outlet domain coverage** — per-outlet SERP builds `site:<domain>`; an outlet with `domain:null` (372/968 in registry, incl. Bachtrack) or the WRONG primary domain (theatreandtonic.com vs live .co.uk) is never searched. `buildSiteClause()` now searches domainAliases too. Dance shows hit hardest: WE aggregators don't cover dance AND dance outlets (Bachtrack/Seeing Dance/DanceTabs/Gramilano) were unregistered.
7. **Generic 1-word titles** ("Sting","Pride","Mass") over-match in SERP (`'sting'` substring → "The Last Ship review sting musical"). `isGenericShowTitle`+`hasDisambiguator` gate (url-discovery.js) now requires a venue/cast/creative-surname corroborator — but ONLY enforced when cast/creative present (else under-collection risk). Gate covers per-outlet SERP, NOT the aggregator path.
8. **Content-swap** — collection occasionally stores outlet A's text under outlet B (same fingerprint, different host). Rebuild's `skippedDuplicateText` dedup then drops the AUTHENTIC copy. Detect: same-text-different-host scan (computeContentFingerprint). Rare (~95% of collisions are legit syndication: AP wire, about.com/NYT, vulture/nymag aliases). Fix = re-capture the contaminated file from its real URL.

**Operational gotchas:** `discoverCorrectUrl(review, scrapingBeeKey, options)` — the SB key is the **2nd positional arg**; passing options there sends an empty key → SERP 400 (looks like "SERP down" but isn't). `gather-reviews` RE-PROCESSING resets `wrongShow` flags → never auto-re-gather an ultra-generic title (re-pulls contamination). `aggregator-coverage.json` `trulyMissing` is NOISY (over-counts via aggregator thumb counts) — don't treat as ground truth. When excluding a roundup/dup, check siblings don't `duplicateOf`→it (would drop the real review); clear with `duplicateClearReason`. Links: [[feedback_off_broadway_opening_date_gap]], [[feedback_previews_open_flip_needs_review_signal]], [[feedback_content_quality_regex_fps]], [[feedback_pending_no_byline_strand_drain]], [[feedback_paywalled_star_outlets_not_gaps]], [[feedback_review_recovery_pipeline_gaps]].

**Gate 9 — same-URL dedup can drop a review that was collected AND scored (2026-08-13, How the Other Half Loves / Old Vic).**
The publication stage fails even when collection succeeds. Two files can exist for one URL: an `--unknown` file that IS scored (submit-review-form / poller path) and a named-byline twin that is NOT (theatre-record path, arrives later). Rebuild's tie-break prefers the real criticName (#190/#1321) without checking scored-ness, picks the unscored file, and the review then fails the scored-entry requirement and disappears from reviews.json entirely — worse than either input alone. Symptom on opening night: 20+ review-texts files, 17 `isIncludableForRebuild()===true`, but only 2 entries in reviews.json and a composite built from 2 reviews on prod.
Diagnose with, per file: `isIncludableForRebuild(d)`, `hasValidScore(d)` (scripts/lib/review-guards.js) and `isScoreable(d, show, path)` (scripts/llm-scoring/is-scoreable.ts). The signature is `INCL + hasValidScore=false` on a named file whose `--unknown` twin has `assignedScore`. Both twins scoreable-and-unscored means the batch scorer simply hasn't reached them — check whether an `llm-ensemble-score.yml` run is already in flight (concurrency group `scoring-reviews` serializes, so dispatching another only queues) before dispatching a `show_id`-scoped run.
Tonight's workaround = score both twins so dedup picks a scored file either way. Real fix = task #1406 (scored-ness must dominate byline quality; ideally MERGE the named byline onto the scored record, which also closes #27).

## Gate: CI step ordering turns a fail-closed gate into a permanent block (2026-08-13)

`opening-night-broadcast.yml` has a single job. Its checklist gate (`id: checklist_gate`, ~line 318)
runs `node scripts/opening-night-checklist.js` — but `actions/setup-node` + `npm ci` don't appear
until ~line 556. No `node_modules` at gate time, so `require('cheerio')` inside
`scripts/lib/page-validator.js` throws MODULE_NOT_FOUND, the checklist reports `-1 checklist error(s)`,
and the gate (correctly fail-closed since the earlier silent-pass bug) blocks the broadcast.

Evidence: run 31698766434, show how-the-other-half-loves-west-end-2026, which had 13 scored reviews live.
cheerio is a real prod dependency — the package was never missing, only the install step ordering.

**Generalisation:** a gate that fails closed on crash is only safe if the crash surface is small.
When auditing a blocked pipeline, distinguish "gate found a problem" from "gate could not run" —
`-1` / negative sentinel counts and MODULE_NOT_FOUND in a gate log mean the second.
Check that every workflow running repo scripts installs deps BEFORE the first script step, not just
before the step that happens to have needed them when the workflow was written.
Card: 3bb637c5-416f-8172-93ce-ec312113add0.

## Gate: a bad discovery row blocks the whole update-show-status commit → no opening-night flip, no poller (found 2026-08-18, card #1786)
`opening-night-poller.yml` has **no cron** — its only dispatcher is `update-show-status.yml`, which flips `previews`→`open`. So any failure of update-show-status silently disables ALL opening-night review discovery, for every show, with no alert.
On 2026-08-18 it had failed **4 consecutive daily runs**: discovery re-created a duplicate `the-sound-of-music-2027` colliding with the misnamed `the-sound-of-music-2026` (id says 2026, openingDate 2027-04-15 LCT), tripping validate-data.js's same-title-sibling date guard → `refusing to commit or push` → exit 1. The offending row is never committed, so it is regenerated every run: **permanent, self-regenerating, never self-heals.** The held-back-show attribution that should have isolated it logged `Revert of held-back show(s) [] did not clear the new error(s)` — an EMPTY attribution set that fell through to blocking everything.
**Check this FIRST when an opening night shows zero discovered reviews:** `gh run list --workflow=update-show-status.yml --limit 4 --json createdAt,conclusion`. Red for days = the chain never armed; the show is still `previews` and the poller was never dispatched.
**Manual bypass (do this on the night, don't wait for the fix):** after press night, flip `status` to `open` in shows.json, commit+push, then `gh workflow run opening-night-poller.yml -f show_id=<id>`. Always pass `-f show_id=` — per-show concurrency; the shared `auto` group cancel-cascades (8 of 10 recent poller runs concluded `cancelled`).

## Gate: a tryout-venue review scores onto the transfer and becomes the show's ONLY review (found 2026-08-18, jeeves-takes-charge-west-end-2026)
Inverse of the same-venue-predecessor leak. A **prior run of the SAME production at a DIFFERENT venue** gets ingested onto the new run's show id, and because it is a paywalled star-outlet stub it is scored from `originalScore` alone (`scoreSource: originalScore-priority0`, len=0 body, `publishDate: null`) — so none of the text-based wrong-production guards ever look at it.
Concretely: The Stage's review of the **Ustinov Studio Bath** run (URL literally `...-at-ustinov-studio-bath-...`, Dec 2024) carried `4/5 → assignedScore 80` onto the **Charing Cross** run (13 Aug–6 Sep 2026) and was the **only row in reviews.json for that show on press-night day**. Its sibling WhatsOnStage review of the same Bath run was already flagged `wrongProduction`, so the corpus was internally inconsistent — one Bath review excluded, one scored.
**Why it is dangerous, not cosmetic:** with one scored review the site publishes a composite sourced entirely from a different venue's run. Same star (Sam Harrison) means "is it the same production?" answers *yes* and feels like a reason to keep it — it is not. Same production ≠ same run; the London composite must come from London press night. The only legitimate way to count a prior run is declaring `priorRuns {dates, venue}` on the show ([[feedback_returning_production_priorRuns]]).
**Detect:** on any opening night, before trusting a score, list the show's reviews.json rows and read their **URL slugs for a venue name**. A slug naming a venue that is not the show's venue is the tell — `contentTier: stub` + `publishDate: null` + `originalScore` present is the high-risk shape, because it bypasses body-based guards entirely.
**Fix applied:** set `wrongProduction: true` + `wrongProductionReason` (manual prose, so the dateless-revival auto-clear respects it) + `manualWrongProductionFlag/FlaggedAt/FlaggedBy`. review-texts `6de3154ff68`.
**Systemic prevention wanted:** a validate-data/CI gate that fails when a show's scored rows include a URL whose venue token does not match the show's venue and the show declares no `priorRuns`.

---

## Gate: an alerting exit code gates the commit that carries the data (2 instances in one night, 2026-08-18)

Not a discovery gate — a **delivery** gate, and it hides as a deploy problem. A workflow runs an audit/validation script, then commits the data the script produced. The script exits non-zero on a *condition it is designed to report* (residual review gaps, validation errors), and that exit takes down the commit step with it. The workflow "fails", the data never lands, and the last-good file stays live indefinitely.

**Instance 1 — `update-show-status.yml`:** `validate-data.js` exited 2 on a duplicate same-title show pair, blocking the commit, so NO status flips persisted — including `previews`→`open` for opening-night shows. Self-regenerating: the offending entry was recreated by discovery each run and died with each blocked commit. 4 consecutive daily failures (task #1786, fixed by dedupe).

**Instance 2 — `audit-aggregator-gap.yml`:** `audit-opening-night-coverage.js --write-ledger` exits 1 when it finds residual review gaps — which is the *normal* state (31 shows had them). Steps "Run gap audit" and "Commit audit JSON (public repo)" both fail, so the coverage/census ledger never commits. 3+ consecutive failures 2026-08-18 (32163322625, 32168356295, 32174979536). Task #1791.

**The tell that saves the most time:** prod slim JSON `cov.computedAt` frozen days back *while deploys are landing fresh*. Run `set -a && . ./.env; set +a && node scripts/check-prod-deploy.js HEAD` — if it reports a READY production deployment minutes old, the deploy leg is innocent and the writer upstream is the break. Then `git log -- data/audit/` (or the relevant data path): no commits from that workflow = confirmed. Do not spend a pass suspecting Vercel.

**Detect generally:** grep `.github/workflows` for a commit/push step that follows a script exiting non-zero on a data-quality condition, and that lacks `if: always()`.

**Prevention shape:** alert conditions set a step *output*, never the process exit code; the commit step is `if: always()`; a dedicated final step reads the output and decides whether to fail the run, AFTER the commit has landed.

**Launchd gotcha that masks all of this:** under launchd the shell has no env, so `check-prod-deploy.js` prints "VERCEL_TOKEN not set" and **exits 0** — it looks like a pass. Always `set -a && . ./.env; set +a` first in a headless pass.

## Gate: fetchPage url_mismatch guard rejects legitimate site redirects (2026-08-18)
`fetchPage()` returns "All scraping methods failed" for `britishtheatreguide.info/reviews/index` and
`thereviewshub.com/category/uk-regional/london/` while a plain desktop-UA curl fetches both (23KB / 79KB)
in ~12s. Chain trace: SD skipped (breaker) → BD skipped (breaker) → **ScrapingBee HTTP 200 discarded by the
url_mismatch guard** (asked `/reviews/index`, site redirected to `/reviews?q=index`) → Playwright fails.
A site-side redirect is being read as "wrong page", so a working provider becomes a chain-wide failure and
any review published on those index pages is invisible to opening-night discovery.
Reproduced 3x across 2 monitor passes (jeeves-takes-charge-west-end-2026, attempts 16 + 17).
Card: "P1: fetchPage url_mismatch guard rejects legitimate site redirects…" (3c0637c5-416f-81e2-bee3-c5672f1393ee, parked).

**Two things that look like this gate but are NOT bugs:**
- `⚠️ skipping SD/BD for non-opening-night calls` in an ad-hoc census script is correct. The breaker
  exemption keys on script name / `GITHUB_WORKFLOW` / `BD_OPENING_NIGHT` (scrapingdog-caps.js,
  brightdata-caps.js) — **not** on fetchPage's `purpose` option. `opening-night-poller.yml` is exempt;
  `fetchPage(url,{purpose:'opening-night'})` does nothing. Export `BD_OPENING_NIGHT=1` for census scripts.
- `whatsonstage.com/news/reviews/` returning ~4.2KB is site-side JS rendering — plain curl gets the same
  shell. Census WhatsOnStage via its `?s=` site-search or a JS-rendering fetch, not that index page.

## Gate 21: submit-review-form accepts outlets with NO registered domain, and the LLM scores marketing copy (2026-08-19, Jeeves Takes Charge WE)
`staybook.in/activities/jeeves-takes-charge` — a ticket-booking listing page — was ingested via the `submit-review-form` source path with `domainUnvalidated:true` / `domainUnvalidatedReason:"no registered domain for outlet staybook - URL host not checked"`, then LLM-scored **78 / Positive** (confidence "low") off one promotional line naming the lead actor. It went live and inflated the composite from 64.81 to 66.18 across 7 entries. Body was pure booking copy ("Get your booking confirmed instantly", "Grab great deals before they are gone").
**Two gates failed independently:** the domain gate degraded to a warning flag instead of a block, and the non-review classifier never fired before scoring.
**Detection:** only the reverse diff (prod entries the independent census cannot corroborate) caught it. Forward-only gap-hunting is blind to this class.
**Manual fix:** `isNonReview:true` + `isNonReviewReason` (do NOT use the `"CV-promoted (not a review):"` prefix — `isNonReviewDemotedByFreshCV` will demote it back) + `manualNonReviewSet/At/By` + `scoreStatus:EXCLUDED_NON_REVIEW` + `excludeFromScoring:true`, then rebuild.

## Gate 22: ingest-review-from-url.js overwrites a DIFFERENT production's review-texts file (2026-08-19, 3x in one night)
Ingesting a URL whose derived filename collides with an existing outlet--critic file overwrites that file **in place**, destroying another production's review. Happened three times on one opening night (The Stage file corrupted at attempt 49). Filed as Notion `3c1637c5-416f-81b1-9183-da19facd8e89`. Symptom: a previously-live review silently changes show/content after an unrelated ingest. Always `git diff` review-texts after any `ingest-review-from-url.js` run.

## Gate 23: an hourly audit workflow can be green-by-absence — its output freezes while the workflow dies on the COMMIT step (2026-08-19)
`audit-aggregator-gap.yml` failed 6 of its last 7 runs, so `data/audit/show-review-gap.json` froze at 09:29:52Z on local main, origin AND prod — the coverage-gap detector was dead for 5+ hours inside a live opening-night window and nothing alerted. Root cause is not the audit logic: the "Commit audit JSON (public repo)" step exhausts all 5 push attempts under CI contention, and `push-with-retry` disqualifies its own `data/audit/*` diffs from the Git Data API fallback (same blanket rule as MANAGED/shows.json/reviews.json), so the step has no way to land when concurrent scoring commits move HEAD.
**Detection rule:** whenever an audit JSON's `generatedAt` stops advancing, check `gh run list` for the PRODUCING workflow before trusting the snapshot. A stale audit reads identically to a passing audit — nothing distinguishes "no gaps found" from "the gap finder never ran". Public `cov{}` on every show JSON is downstream of this file, so a frozen snapshot ships wrong coverage badges to prod (jeeves showed `liveCount:1` against actual `rc:6`).
**Parked fix:** Notion `3c1637c5-416f-81d0-b8de-d138f3fc2c24` (P1) — allow the API fallback for `data/audit/*`, give the audit commit its own concurrency group, and add a >2h staleness alarm. Parked because it edits `scripts/lib/push-with-retry.sh` (CLAUDE.md rule 18: `/second-opinion` + review-gate record before the first edit).
