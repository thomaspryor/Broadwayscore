# Triage: scripts/audit-*.js that nothing runs (BRO-2688)

Swept on 2026-10-23 against origin/main. BRO-2620 fixed one audit script that wrote a
report while nothing in CI ran or read it (24 true positives went unalerted). This is the
sweep for the same pattern across the other audit scripts. Detector:
`scripts/lib/audit-script-wiring.js`; baseline and per-script reasons:
`scripts/lib/audit-script-wiring-baseline.json`; guard: `tests/unit/audit-script-wiring.test.mjs`.

## What the sweep found

The card's crude grep (filename absent from every workflow except test.yml) flagged about
120 of the 277 `scripts/audit-*.js` files. Checking each flagged file against every other
place a script can be reached cuts that to 32:

| Population | Count |
| --- | --- |
| `scripts/audit-*.js` files | 277 |
| Named in a workflow other than test.yml, a composite action, or package.json | 84 |
| Run by a `run:` step in test.yml (alert-reachability, delete-without-breadcrumb, direct-github-api, invisible-verification) | 4 |
| Reached some other way: `require()`d by a wrapper or lib, called from a hook, or run by an orchestrator script (bucket c) | 157 |
| Referenced nowhere, or only by a test.yml `paths:` trigger line, which runs nothing | 32 |

The 157 bucket (c) scripts were not read one by one. They share a reference from other
non-test code, which is the mechanism the card named ("invoked indirectly"). A script in that
group that is only an unused library import would still count as reached; tightening that is
out of scope here. The 32 are triaged individually below.

## Bucket (a): orphaned and worth alerting on (12)

Ranked by consequence: published-score correctness first, ingest hygiene next, then
history-based and clean-today guards. "Needs review-texts" means the script reads
`data/review-texts`, which is private; it can only run in a job that has the private-data
composite action, as `data-health-check.yml` does. This session had no review-texts, so those
scripts were read but not run; only the three core-data scripts below were run.

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
(CLAUDE.md §18), which is why this card stops at the plan.

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

## Bucket (b): intentionally manual, one-shot, or cannot run in CI (20)

Each of these is a diagnostic, a sprint-scoped check, or needs a local environment (worktrees,
the iOS repo, an image archive, a pasted input). The six BRO-5420 and BRO-5373 cousin sweeps
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

157 scripts; see the table at the top. The four test.yml `run:` scripts above are the ones the
card's grep missed because it excluded test.yml entirely.

## Keeping the class closed

`tests/unit/audit-script-wiring.test.mjs` (collected automatically by
`scripts/lib/unit-test-collection.js`, so no workflow edit) fails when a new `scripts/audit-*.js`
is referenced nowhere and is not in the baseline. A test.yml `paths:` entry does not count as
wiring, because that line only decides when the test job triggers. The gate is a baseline gate
(rule 19): the 32 scripts above are listed, so it blocks only new orphans. Wiring one of them
removes the need for its baseline entry; delete the entry in the same change.

## Untriaged (bucket u)

An independent review found the first detector counted comment-only mentions and lint-baseline JSON lists as wiring. The detector now ignores both, which surfaced 57 more scripts. They are in the baseline as bucket `u` (untriaged): each needs a read, then a move to bucket a (wire it) or b (exempt with a reason).

- `audit-apply-scripts-verify-pushed.js`
- `audit-audience-scores.js`
- `audit-awards-data.js`
- `audit-bro79-ensemble-rejections.js`
- `audit-close-time-verify.js`
- `audit-content-quality.js`
- `audit-coverage-slot-drops.js`
- `audit-creative-team-serp.js`
- `audit-critic-tenure.js`
- `audit-cross-attribution-by-critic.js`
- `audit-doubled-market-ids.js`
- `audit-duplicate-images.js`
- `audit-excerpt-only-backfill-queue.js`
- `audit-explicit-scores.js`
- `audit-false-dead-ledger-rows.js`
- `audit-fetch-timeouts.js`
- `audit-field-consistency.js`
- `audit-flag-wipe-signature.js`
- `audit-git-show-maxbuffer.js`
- `audit-grosses-data.js`
- `audit-late-add-corpus-wide.js`
- `audit-levenshtein-matches.js`
- `audit-llm-hallucinations.js`
- `audit-llm-scores.js`
- `audit-llm-scoring-parity.js`
- `audit-london-outlet-flags.js`
- `audit-mirror-status-drift.js`
- `audit-multi-production-titles.js`
- `audit-multi-verdict-stars.js`
- `audit-multishow-titlecase.js`
- `audit-nonreview-cv-conflict.js`
- `audit-nyt-pick-coverage.js`
- `audit-opening-night-extraction.js`
- `audit-opera-discovery-gap.js`
- `audit-orphan-inprogress.js`
- `audit-orphaned-audit-writes.js`
- `audit-outlet-tiers.js`
- `audit-paywall-leaks.js`
- `audit-registry-nonreview-outlets.js`
- `audit-reroute-backlog.js`
- `audit-review-pair-anomalies.js`
- `audit-safe-form-allowlist.js`
- `audit-show-score-url-redirects.js`
- `audit-single-author-mismatches.js`
- `audit-soft-404-review-texts.js`
- `audit-stale-open-premises.js`
- `audit-text-gap-cards.js`
- `audit-truncated-reviews.js`
- `audit-url-collisions.js`
- `audit-url-validation.js`
- `audit-we-historical-season.js`
- `audit-we-market-misroutes.js`
- `audit-we-reviews.js`
- `audit-wet-roundup-bleed.js`
- `audit-workflow-activity.js`
- `audit-wrong-article-parity.js`
- `audit-wt-integ-stashes.js`
- `audit-timeout-patterns.js`

The population figure for "reached some other way" above predates this fix and is overstated by these scripts.
