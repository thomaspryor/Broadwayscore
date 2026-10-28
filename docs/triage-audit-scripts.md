# Triage: scripts/audit-*.js that nothing runs (BRO-2688)

Swept on 2026-10-23 against origin/main. BRO-2620 fixed one audit script that wrote a
report while nothing in CI ran or read it (24 true positives went unalerted). This is the
sweep for the same pattern across the other audit scripts. Detector:
`scripts/lib/audit-script-wiring.js`; baseline and per-script reasons:
`scripts/lib/audit-script-wiring-baseline.json`; guard: `tests/unit/audit-script-wiring.test.mjs`.

## What the sweep found

BRO-6038 reran `findUnreferencedAuditScripts(process.cwd())` against the real
checkout. The detector scans workflow run steps, composite actions, package scripts
and other non-test code. Comment-only mentions, lint-baseline JSON and test.yml
path triggers do not count as wiring.

| Population | Count |
| --- | --- |
| `scripts/audit-*.js` files | 283 |
| Referenced by workflow/action/package or other non-test code (bucket c) | 192 |
| Unreferenced and retained in the baseline | 91 |
| Bucket a: alertable, awaiting wiring | 33 |
| Bucket b: manual, one-shot, local-only or already covered by tests | 58 |
| Bucket u: untriaged | 0 |

The baseline actually contained **58** bucket-u entries, not the card's 59 or the
older document's 57. All 58 now have a script-specific a/b decision below: 21 are
alertable and 37 stay manual. The original 12 bucket-a and 20 bucket-b records are
unchanged. Classification changes do not run, disable or wire an audit and do not
change any show, review, score or private-data record.

## Bucket (a): orphaned and worth alerting on (33)

The original 12 retain BRO-2688's priority order and historical sweep evidence below;
findings labelled "today" are from that sweep, not a new claim about the current corpus.
The 21 newly classified alertable scripts are listed in the BRO-6038 triage section
with rank 99 (unranked), leaving the top-eight priority order intact.
"Needs review-texts" means the job needs the private-data composite action, as
`data-health-check.yml` has. Bucket a is a scheduling recommendation, not evidence
that a script already supports `--counts` or has a digest consumer.

| Rank | Script | Why it matters |
| --- | --- | --- |
| 1 | `audit-star-bands.js` | CLAUDE.md §3 star-band invariant; core data only; live run today shows 1 review out of band (scoreSource originalScore-priority0) |
| 2 | `audit-announced-cast.js` | announced shows must not hold an older production's cast (BRO-5809); core data only; live run today flags the-wedding-march-off-broadway-2026 |
| 3 | `audit-scoreless-llmscore.js` | files with an llmScore object but no numeric score are never scored or published (BRO-5395); needs review-texts |
| 4 | `audit-uncounted-real-reviews.js` | review texts on 2026 shows missing from reviews.json (BRO-5794); needs review-texts |
| 5 | `audit-listing-page-text.js` | listing or search page scored as a review (BRO-5375, scored 87 on the site); only a test.yml path trigger today; needs review-texts |
| 6 | `audit-promo-booking-copy.js` | booking and deal copy ingested as review text (BRO-5902, BRO-5906); only a test.yml path trigger today; needs review-texts |
| 7 | `audit-ownership-gate-losses.js` | reviews dropped by the push ownership gate that exist nowhere in the corpus (BRO-5373); needs review-texts git history |
| 8 | `audit-corpus-determinism.js` | published review count moving down or flapping; PASS today; needs deploy-watermark git history |
| 9 | `audit-flagged-file-contamination.js` | merge target landing inside a flagged review file (BRO-3219); only a test.yml path trigger; needs review-texts |
| 10 | `audit-stale-review-texts.js` | stale manual-clear reasons hiding genuinely wrong texts (BRO-2395); only a test.yml path trigger; needs review-texts |
| 11 | `audit-shared-url-quote.js` | multi-show column copied whole onto each show (BRO-4594); report only; needs review-texts |
| 12 | `audit-form-d-capitalization.js` | commercial.json capitalization stored as the Form D maximum (BRO-5732); clean today (0 of 37); core data plus SEC fetch |

### Action plan for the top 8

Pattern for every item: add a step to `data-health-check.yml` modelled on the existing
`audit-star-band-drift.js` and `audit-coverage-holes.js` steps (`--counts=data/audit/<name>.json`),
shadow mode first (`continue-on-error: true`, rule 19), then one digest row fed from the counts
file, then arm it after two clean weeks. Workflow edits need a recorded `/second-opinion`
(CLAUDE.md §18). The unattended BRO-6038 worker is prohibited from editing workflows
or running session skills, so this wiring remains outstanding; the triage below is
completed independently.

1. `audit-star-bands.js`: wire first. Core data only, and it already reports 1 review out of band
   (`originalScore-priority0`). Check overlap with the wired `audit-star-band-drift.js` before
   adding a second digest row; if the drift script already covers the finding, fold the
   per-cohort table into it instead.
2. `audit-announced-cast.js`: wire second. Core data only; it already flags
   `the-wedding-march-off-broadway-2026` (announced row, no cast file). Needs a `--counts` flag
   (it has `--strict` only).
3. `audit-scoreless-llmscore.js`: a file here is never scored and never published, so a count
   above zero is a silent score gap. Needs review-texts; run in the job that already has it.
4. `audit-uncounted-real-reviews.js`: same silent-gap class from the reviews.json side.
5. `audit-listing-page-text.js`: its detection of search and tag-archive pages in review text
   caught an 87-scored listing page. Its only reference is a test.yml trigger path, so nothing runs it.
6. `audit-promo-booking-copy.js`: same shape, booking and deal copy. The trigger-path-only reference
   again means it never runs.
7. `audit-ownership-gate-losses.js`: detects lost reviews. Needs the review-texts git log, so it
   runs only where that history is checked out; add `fetch-depth` for the window.
8. `audit-corpus-determinism.js`: PASS today. Cheap to run weekly; alert when the published
   count moves down by 40 or more.

Items 9 to 12 (`flagged-file-contamination`, `stale-review-texts`, `shared-url-quote`,
`form-d-capitalization`) follow the same recipe after the top 8 have a clean baseline.

## Bucket (b): intentionally manual, one-shot, local-only or redundant in CI (58)

The original 20 below are diagnostics, sprint-scoped checks, or need a local environment
(worktrees, the iOS repo, an image archive, a pasted input). The additional 37 decisions
appear in the BRO-6038 triage section. The six BRO-5420 and BRO-5373 cousin sweeps
at the top of the list are read-only follow-ups to incidents; if a run in a job with
review-texts finds hits, promote that script to (a).

| Script | Why it stays manual |
| --- | --- |
| `audit-always-commit-after-validate.js` | advisory workflow linter (BRO-5293); exits 0 by design, rule 19 forbids arming it |
| `audit-cast-matching.js` | one-shot re-evaluation of cast files against new IBDB matching rules |
| `audit-critic-listing-parity.js` | one-shot parity check for decideCriticListingPromotion (task 995); sprint-scoped |
| `audit-critic-name-apostrophe.js` | read-only sweep for BRO-5444 truncated critic names; promote to (a) if a run with review-texts finds hits |
| `audit-data-quality.js` | metrics dump to stdout for ad-hoc inspection; no pass/fail |
| `audit-demoted-nonreview.js` | read-only sweep from the BRO-5420 incident; promote to (a) if a run with review-texts finds hits |
| `audit-director-guard-dates.js` | read-only cousin sweep for BRO-5373; promote to (a) if a run with review-texts finds hits |
| `audit-feature-as-review.js` | read-only sweep from the BRO-5420 incident; promote to (a) if a run with review-texts finds hits |
| `audit-feedback-overnight-branches.js` | inspects local checkouts of the iOS app repo; cannot run in CI |
| `audit-flat-git-add.js` | advisory workflow linter (BRO-2945); exits 0 by design, rule 19 forbids arming it |
| `audit-image-aspect.js` | poster geometry check over a local image archive; hygiene, not correctness |
| `audit-non-quote-excerpts.js` | diagnostic count for BRO-5344; no pass/fail threshold |
| `audit-outlet-text-status.js` | one outlet's text coverage on demand; diagnostic with an outlet argument |
| `audit-roundup-coverage.js` | CLI wrapper for a pasted editorial roundup; manual input by design |
| `audit-scored-other-critic.js` | read-only sweep from the BRO-5420 follow-up; promote to (a) if a run with review-texts finds hits |
| `audit-split-section-scores.js` | read-only sweep for BRO-6000 split-section back-references; needs review-texts and judgment per hit |
| `audit-stranded-reviewed-branches.js` | inspects local worktrees; exits 2 as untrustworthy where none exist; Mac-only |
| `audit-title-quality.js` | title artifact buckets, report only (BRO-3915); hygiene |
| `audit-tour-leg-venues.js` | report-only corpus audit (BRO-2278); needs judgment per hit |
| `audit-uk-rows-on-broadway.js` | read-only sweep from the BRO-5420 incident; promote to (a) if a run with review-texts finds hits |

## Bucket (c): wired some other way

192 scripts have a non-test reference under the detector's current rules. A reference
establishes reachability, not that every caller is scheduled or that its report reaches
a digest. Tightening that indirect-call analysis is outside this triage.

## Keeping the class closed

`tests/unit/audit-script-wiring.test.mjs` (collected automatically by
`scripts/lib/unit-test-collection.js`, so no workflow edit) fails when a new `scripts/audit-*.js`
is referenced nowhere and is not in the baseline. A test.yml `paths:` entry does not count as
wiring, because that line only decides when the test job triggers. The gate is a baseline gate
(rule 19): the 90 unwired scripts are listed, so it blocks only new orphans. Wiring one of them
removes the need for its baseline entry; delete the entry in the same change.

## BRO-6038: completed stricter-detector triage (58)

Each decision follows the script's CLI, inputs, outputs and write/network paths.
An advisory exit code is not a reason to exempt a recurring correctness check.
Bucket-a scripts should first publish meaningful counts in shadow mode; historical
or intentionally nonzero cohorts need their own semantics rather than a blanket
zero threshold. Source-only checks can use an advisory CI step instead of a data cron.
Bucket-b reasons state why a daily cron would be redundant, misleading, expensive
without a scope, tied to a retired system, or unsafe without manual adjudication.

### Additional bucket a: alertable (21)

| Script | Decision and scheduling reason |
| --- | --- |
| `audit-apply-scripts-verify-pushed.js` | Finds --apply scripts that write review texts without verify-review-texts-pushed, risking fixes left only on disk; schedule as a source-only advisory count, not a blocking gate. |
| `audit-audience-scores.js` | Checks audience-buzz score ranges, source weights, designations and staleness against shows.json; recurring published-data drift merits a digest using report severity counts; no network calls. |
| `audit-awards-data.js` | Checks awards.json for orphan show IDs, duplicate nominations, impossible wins and season gaps; recurring catalog edits can regress these, so schedule severity counts; needs awards.json, no network calls. |
| `audit-coverage-slot-drops.js` | Finds aggregator URL slots, other-critic URL ownership, dateless holds and stale non-review slots with replacement reviews; recurring ingest losses merit candidate counts; needs review-texts, no fetches. |
| `audit-critic-tenure.js` | Counts unresolved critic/outlet tenure mismatches using findTenureFlags and reviewed exceptions; new attribution errors warrant recurring visibility; needs review-texts, no network calls, supports --max. |
| `audit-cross-attribution-by-critic.js` | Matches stored review content against title, cast, creative and venue fingerprints to detect wrong-show attribution; schedule report-only confidence counts with review-texts; never --apply on cron. |
| `audit-doubled-market-ids.js` | Standing shows.json detector for market words leaking from titles into generated IDs; new discovery rows can repeat BRO-2886, so schedule sweepShows with its reviewed allowlist; core data only. |
| `audit-fetch-timeouts.js` | Scans source for fetch and HTTP request call sites lacking a matched abort or destroy timeout; recurring hang regressions merit source-only advisory counts; full scan intentionally exits 0 on existing debt. |
| `audit-field-consistency.js` | Detects wordCount, contentTier and legacy text-status drift that can change rebuild inclusion; schedule the default report over review-texts, never --fix; no network calls. |
| `audit-guard-call-sites.js` | BRO-2484 advisory heuristic for audience-facing guards that have a unit test but no test proving their call site; findings need human judgment, so run by hand rather than as a recurring CI step. |
| `audit-lane-trouble-rate.js` | BRO-2978 per-lane dispatch retry burn (troubled tasks and launches) read from the per-machine dispatch ledger, which is gitignored and absent in CI, so it can only be run by hand. |
| `audit-git-show-maxbuffer.js` | Finds git show/cat-file/ls-tree/diff/log subprocesses missing maxBuffer, which can misread large data files as absent; recurring source regressions merit a cheap offline check. |
| `audit-grosses-data.js` | Adds snapshot staleness, missing open Broadway shows, ATP and all-time consistency checks beyond the wired history-integrity rules; schedule severity counts with shows and both grosses files; no fetches. |
| `audit-llm-hallucinations.js` | Uses canonical keyword checks to find LLM-verified live text lacking show identity and quarantine-gate contradictions; schedule separate suspect counts with review-texts, not automatic reclassification; no LLM calls. |
| `audit-llm-scoring-parity.js` | Runs the real rebuild and LLM scoreability predicates over review-texts to expose wasted scoring and orphan-unscored divergences; schedule bucketed report counts, accounting for intentional differences; no LLM calls. |
| `audit-multi-verdict-stars.js` | Finds stored star ratings borrowed from another section of multi-review articles; schedule mismatch counts separately from ambiguous sections using review-texts; --write-plan stays manual, no fetches. |
| `audit-orphaned-audit-writes.js` | Finds workflow audit reports discarded because commit steps never stage them; schedule the source-only --check ratchet against reviewed persistence gaps, with shadow-mode visibility before blocking. |
| `audit-paywall-leaks.js` | Detects subscriber-login boilerplate stored as fullText via the shared positional paywall detector; recurring cookie failures merit a weekly report with review-texts and --strict in shadow mode; no fetches. |
| `audit-review-pair-anomalies.js` | Detects identical text under different critics/URLs and stale own-domain roundup flags across sibling files; per-file guards miss these, so schedule report-only pair and roundup counts with review-texts. |
| `audit-soft-404-review-texts.js` | Finds stored soft-404 templates and byte-identical bodies across critics, complementing the collector guard on newly fetched text; schedule read-only finding counts with review-texts, no live fetches. |
| `audit-url-collisions.js` | Classifies same-show/outlet URL groups to separate legitimate aggregator multi-critic pages from copied-text contamination; schedule contamination counts with review-texts, never --apply; no network calls. |
| `audit-wet-roundup-bleed.js` | Cross-checks cached WET roundup rows and review files for borrowed critics/URLs and cross-outlet domains; schedule unflagged contamination counts, keeping weak leads separate; needs WET archive and review-texts, no fetches. |
| `audit-timeout-patterns.js` | Finds Promise.race timeout wrappers whose timers are never cleared, causing scripts to linger after work ends; schedule the offline source scan as a regression signal, using withTimeout as the repair. |

### Additional bucket b: manual or exempt (37)

| Script | Decision and scheduling reason |
| --- | --- |
| `audit-bro79-ensemble-rejections.js` | One-time repair of named July 2026 ensemble rejections and a Wicked excerpt recovery; writes private review files by default unless --dry-run, so never schedule as a recurring audit. |
| `audit-close-time-verify.js` | Pre-rollout experiment that lists cards through retired notion-brain.js and executes their acceptance commands in a fresh checkout; manual migration evidence, not a daily data-health check. |
| `audit-content-quality.js` | Legacy mixed heuristic sweep includes extractYearFromUrl for production guesses and broad byline/domain checks; keep manual without --fix until checks use sourced metadata under CLAUDE.md section 3. |
| `audit-creative-team-serp.js` | Retro-audits unprovenanced non-Broadway creative credits predating the SERP guard; two searches per member plus optional Opus adjudication and --fix require a scoped, budgeted manual run, not cron. |
| `audit-duplicate-images.js` | Hashes hero, poster and thumbnail files for same-title productions; requires the complete local public/images/shows archive, tolerates absent files and writes a /tmp repair list, so use for image triage. |
| `audit-excerpt-only-backfill-queue.js` | Reports excerpt-only files eligible for the existing daily unscored pipeline; queue size is not a failure or completion guarantee because scoring is capped, so use for manual backfill progress checks. |
| `audit-explicit-scores.js` | Ranks originalScore suspects using positive/negative word lists and extraction-source hints; sentiment disagreement is not proof an explicit rating is wrong, so inspect evidence manually rather than alert on every hit. |
| `audit-false-dead-ledger-rows.js` | Dispatch retry-cap incident probe fetches Linear comments per issue to corroborate dead ledger rows; the live gate already uses classifyDeadRowsForTask, so reserve the extra API scan for investigations. |
| `audit-flag-wipe-signature.js` | Retroactive scan for the pre-16c834c9 maybeUpgradeUrl exclusion-flag wipe breadcrumb; incident-cohort repair needs per-hit review of legitimate clears, not a standing count of all URL changes. |
| `audit-late-add-corpus-wide.js` | Historical late-add census deliberately includes closed shows outside the production ledger window; existing opening-night coverage handles current targets, so use this snapshot for scoped historical cleanup. |
| `audit-levenshtein-matches.js` | Pre-migration inventory of fuzzy critic-name matches to decide which true typos belong in CRITIC_ALIASES; pairs require human identity review before changing matching rules, not recurring alerts. |
| `audit-llm-scores.js` | Blind re-scoring experiment with provider calls, retries, calibration and a spend cap; use --pass1-only or a scoped funded investigation, not an unrestricted daily cron. |
| `audit-london-outlet-flags.js` | BRO-5896 recovery diagnostic groups held and self-healed NYC reviews by current outlet region; legitimate London holds and released totals are not defects, so inspect suspect regions manually rather than gate total flags. |
| `audit-mirror-status-drift.js` | Samples local ~/.claude/tasks mirror entries against live Notion statuses; depends on retired Notion tooling and a workstation mirror, so keep as historical investigation tooling, not CI. |
| `audit-multi-production-titles.js` | Generates same-title production groups as fixtures for routing work; revivals and transfers legitimately share titles, so a collision count alone is not an alertable defect. |
| `audit-multishow-titlecase.js` | A/B replay of titlecase, URL-evidence and flag-clearing rules for BRO-5373/BRO-5395; changed verdicts need cohort adjudication and can retain other exclusions, so run during rule/backfill investigations. |
| `audit-nonreview-cv-conflict.js` | Counts stale isNonReview flags intentionally outranked by fresher verification at read time; these persist on disk and need not drain to zero, so the optional ceiling is diagnostic, not a daily failure signal. |
| `audit-nyt-pick-coverage.js` | Proposes missing NYT Pick reviews using title words in URL slugs and run windows; matches need sourced confirmation under the no-URL-metadata rule before ingestion, so keep candidate research manual. |
| `audit-opening-night-extraction.js` | Post-opening verification requires an explicit --show and live BWW/DTLI pages or cached --no-live inputs; run for a selected opening after reviews exist, not as an unscoped daily catalog scan. |
| `audit-opera-discovery-gap.js` | Replays outlet-site discovery to classify misses for a selected show/category and opening window; live listing fetches can use Bright Data and need a bounded research scope, not a default full-catalog cron. |
| `audit-orphan-inprogress.js` | One-time drain of local mirrored in-progress tasks using cmux, git evidence and retired Notion cards; --fix mutates tasks and cards, and CI lacks the workstation sessions it must corroborate. |
| `audit-outlet-tiers.js` | Builds outlet volume/evidence tables and simulates proposed tier changes from supplied justifications; tier policy needs sourced human decisions and explicit output files, so no automatic recurring gate. |
| `audit-registry-nonreview-outlets.js` | One-time pre-guard registry cross-check against venue, PR and ticketing host rules; domain collisions can flag real scored outlets, so use findings as manual evidence and never remove registry rows on a cron. |
| `audit-reroute-backlog.js` | One-time inventory of already-flagged reviews that might fit sibling productions; requires the main checkout and .core-data-checkout/shows.json plus collision/year-only adjudication, so keep repair planning manual. |
| `audit-safe-form-allowlist.js` | Source-only read-only-allowlist invariants already run in scripts/lib/safe-form-allowlist.test.mjs, including transitive writes and live-gate agreement; CLI --candidates is manual admission research, so no duplicate cron. |
| `audit-show-score-url-redirects.js` | Live per-URL HTTP probe for Show Score mappings redirecting to generic listings; use --show or --limit to investigate a suspected mapping, alongside the offline archive audit, rather than refetch the whole map daily. |
| `audit-single-author-mismatches.js` | Uses critic distribution and staff-turnover exceptions to propose multiAuthor registry changes; low-data and legitimate turnover cases need attribution review, and --apply changes scoring inputs, so keep manual. |
| `audit-stale-open-premises.js` | Backlog research runs open cards acceptance commands in a fresh checkout and marks only stale-premise candidates; broad tests and absent private data are inconclusive, so results need owner judgment, not automatic cron action. |
| `audit-text-gap-cards.js` | Card-specific evidence for BRO-4426, BRO-4564 and BRO-4301, selected with --card and named repair plans; each cohort measures a different text-recovery hypothesis, so use for those investigations. |
| `audit-truncated-reviews.js` | Legacy local heuristic inventory of suspicious endings, paywall phrases and short bodies; findings need article inspection and reuse of current collector rules before becoming a recurring alert signal. |
| `audit-url-validation.js` | Retroactive roundup-URL investigation mixes URL-title guesses, cached archives and potentially paid fetchPage validation; needs a bounded scope and content-based evidence before recurring use, not a default daily sweep. |
| `audit-we-historical-season.js` | Manual release gate for a specified West End backfill --season about seven days after scoring; displayability, run windows, duplicates and provenance determine whether the next season can start, not daily catalog health. |
| `audit-we-market-misroutes.js` | Historical backlog replay of gather-time market routing over flagged West End files; --execute moves private review files and collisions need adjudication, while the standing ingest guard handles new rows. |
| `audit-we-reviews.js` | Live review refetch plus OpenAI and Gemini adjudication per review; default --limit is unbounded and production/sentiment findings need evidence review, so use a funded manual sample, not cron. |
| `audit-workflow-activity.js` | Whole-workflow inventory complements the existing critical-cron monitor; refresh costs about two GitHub API calls per workflow before retries, so use cached/manual retirement reviews rather than daily duplicate polling. |
| `audit-wrong-article-parity.js` | BRO-3956 diagnostic compares wrongArticle checks to canonical rejection; medium-confidence and manual-clear disagreements are intentional in URL ownership routing, so a nonzero parity count is not a recurring defect. |
| `audit-wt-integ-stashes.js` | Read-only triage of the shared workstation stash stack, including dangerous truncations; CI has no representative wt-integ recovery stashes, so run during local stash cleanup, never as a catalog cron. |

### Outstanding workflow deliverable

The top eight ranked audits remain unreferenced by `data-health-check.yml`.
After the infrastructure review gate in CLAUDE.md section 18 is satisfied, wire each
with `--counts=data/audit/<name>.json` (adding supported counts output where absent),
`continue-on-error: true`, a digest row and any required private-data/history checkout.
Remove each baseline entry when wired, as enforced by the stale-entry test. Preserve
the recorded star-band-drift overlap check and shadow-mode observation period.
No new cron, fetch, LLM request or API call is introduced by this classification change.
| `audit-excluded-with-own-show-evidence.js` | BRO-5805 read-only sweep of excluded review files whose text names the show's own cast; needs the private review-texts corpus, so run it through cloud-run-script. Gate mode exists but is unwired. Promote to (a) once a run finds real hits. |
| `audit-malformed-review-urls.js` | BRO-5162 read-only sweep of review-text files whose url is not an absolute http(s) url with a dotted host, and which of them ship in reviews.json; needs the private review-texts corpus, so run it through cloud-run-script. Standing prevention is the write-time guard in review-write-guard. |
