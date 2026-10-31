# BRO-5743: holding-directory consumer audit

CommonJS and ESM imports of `scripts/lib/list-show-dirs.js` under `scripts/` and `tests/`,
including aliases. Local functions merely sharing the name are not consumers.
One written decision per importing file follows.

## Policy

Use `{ skipHolding: true }` where directory names supply production identity to
pair comparisons, same-show repairs, or filed-production checks. It excludes
every immediate `_`-prefixed directory, including future holding names.
Keep the default false for file-local diagnostics, physical inventories,
backfills, snapshots and forensic ownership searches. Existing known-show
membership checks and underscore filters already protect their comparisons.
Images, transcripts and children inside `_pending` have separate contracts.

`report-review-drift-details.js` opts in only for its `dups` class.
`cleanup-review-sources.js` filters the reviews loaded for dedup, preserving
its independent temporary-file cleanup scan. Existing explicit skip callers,
including the already-fixed critic-spelling consumer, stay unchanged.

## Root cause and verification

The writer is intentional: `_retireSupersededSlot()` in
`scripts/lib/review-file-writer.js` archives flagged files in
`_superseded-misattributed`; `review-write-guard.js` quarantines under
`_pending/{showId}`. Consumers must not assign a holding container a production
identity. No private review-text files were written.

HEAD and origin/main started at `f85289f0`. The card acceptance already passed
7/7 on main. `git log -S 'skipHolding' --oneline -5 --
scripts/lib/list-show-dirs.js` returned no commits. Searching for
`showId.startsWith('_')` in the critic-spelling helper finds its existing fix
in available history. The new shared-option regression failed before the
implementation (6 pass, 1 fail), then the helper and acceptance passed 14/14.

Real corpus before/after:

- Directories: 2,643 -> 2,641. Only `_pending` and
  `_superseded-misattributed` disappear. The latter has 117 JSON files.
- Cloned-excerpt pairs: 4,640 -> 4,429. All 211 removed pairs are archived;
  the complete array of real-show pairs passes deep equality before/after.
- Review-duplicate groups: 1,050 -> 1,036; cross-show URL groups:
  3,972 -> 3,924; files: 57,907 -> 57,790. Same-show URL duplicate, sentiment,
  outlet-as-critic and domain-mismatch counts remain unchanged. The audit
  exceeds its pre-existing thresholds both before and after this change.
- Key-duplicate findings: all 12 unchanged; files: 57,907 -> 57,790.

False archive groups removed include Maryam Philpott at The Reviews Hub
(`1536` and `Les Liaisons Dangereuses`), Stuart King at London Box Office
(`1536` and `Blood of My Blood`), and The Reviews Hub London (`1536` and
`Archduke`). The records' stored showId values confirm these are different
productions.

The existing callers below wire the new option. No new paid fetches, LLM
calls, API calls, cron jobs or workflows. Existing paid paths receive the same
or fewer records. No backfill or private-data writes are required.

## Validation commands

- `node --test scripts/lib/critic-spelling-duplicates.test.mjs`: 7 pass on the initial main checkout.
- `node --test --test-timeout 300000 scripts/lib/list-show-dirs.test.mjs`: new regression first failed (6 pass, 1 fail).
- `node --test --test-timeout 300000 scripts/lib/critic-spelling-duplicates.test.mjs scripts/lib/list-show-dirs.test.mjs`: final 14 pass.
- `node scripts/audit-levenshtein-matches.js`: pass before/after; 874,608 -> 871,758 pairs checked, with the same 13 exact and 99 alias matches and zero Levenshtein findings.
- `node scripts/audit-review-duplicates.js`: existing threshold failure before/after; removed only holding-directory groups from production comparisons.
- Direct `run()` from `audit-cloned-excerpts` and `countKeyDuplicates()` from `audit-review-key-duplicates` ran over the real corpus before/after, with equality checks on retained findings.
- The real main/current helper comparison passed for three roots: review texts (2,643 -> 2,641), images (3,438 -> 3,438), and nested pending shows (861 -> 861).
- `git diff --check`: checked before completion. No TypeScript or workflow files changed. A specific .gitignore exception keeps this audit in the diff.

Affected test files, executed with Node's test runner (748 pass, 2 pre-existing
corpus failures, 750 total):

```sh
node --test --test-timeout 300000 \
  scripts/audit-cross-outlet-attributions.test.mjs \
  scripts/audit-cross-show-url-collisions.test.mjs \
  scripts/lib/critic-spelling-duplicates.test.mjs \
  scripts/lib/cross-outlet-pointer.test.mjs \
  scripts/lib/identical-text-sibling.test.mjs \
  scripts/lib/list-show-dirs.test.mjs \
  scripts/lib/merged-duplicate-urls.test.mjs \
  scripts/lib/multi-show-review-fanout.test.mjs \
  scripts/lib/outlet-split-sunday-times.test.mjs \
  scripts/lib/review-guards.explain.test.mjs \
  scripts/lib/review-guards.test.mjs \
  scripts/lib/url-change-invariant.test.mjs \
  scripts/lib/write-then-delete.test.mjs \
  scripts/lib/wrong-production-clear.test.mjs \
  scripts/lib/wrongproduction-provenance.test.mjs \
  scripts/lib/wrongshow-autoclear-ensemble.test.mjs \
  scripts/tests/help-flag-safety-guard.test.mjs \
  scripts/tests/verify-edits-scoring-gate.test.mjs \
  tests/acceptance/variety-promo-bleed.test.mjs \
  tests/unit/cleanup-phantom-outlets-locked.test.mjs \
  tests/unit/data-quality-pipeline.test.js \
  tests/unit/dedupe-syndicated-reviews.test.mjs \
  tests/unit/detect-syndicated-duplicates-locked.test.mjs \
  tests/unit/integrity-report.test.js \
  tests/unit/nonreview-contenttype-wrongshow.test.mjs \
  tests/unit/review-normalization.test.js \
  tests/unit/review-texts-dir-resolution.test.mjs \
  tests/unit/sibling-matchers-diacritics.test.mjs \
  tests/unit/syndication-pairs-shared.test.mjs \
  tests/unit/wrong-production-autoclear.test.mjs \
  tests/unit/wrong-production-setters-honor-manual-clear.test.mjs
```

The two failures also occur with the exact `origin/main` helper loaded through
Node's module cache (all other dependencies for these tests are unchanged):

```sh
node --require /tmp/bro-5743-main-helper.cjs --test --test-timeout 300000 scripts/audit-cross-outlet-attributions.test.mjs tests/acceptance/variety-promo-bleed.test.mjs
```

Result: 4 pass, 2 fail, identical findings: 2 unreviewed cross-outlet attribution
suspects and 4 Variety promo-bleed files. Private corpus repairs are outside
this card. The preload only compiles `git show origin/main:scripts/lib/list-show-dirs.js`
at its real module filename, so these tests execute main's helper unchanged.

The final two caller edits were also checked with:

```sh
node --test --test-timeout 300000 tests/unit/wrong-production-setters-honor-manual-clear.test.mjs scripts/tests/help-flag-safety-guard.test.mjs tests/unit/sibling-matchers-diacritics.test.mjs
```

The final caller check passed 64/64.

Workflow gate command: `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`.
The gate's only failure was missing `actionlint` (`command not found`, exit 127),
which the worker instructions explicitly allow. The test collection and script
coverage audits passed. Generated audit reports are restored before handoff.

## Decisions

263 importing files, including tests.

| Consumer | Policy | Written reason |
| --- | --- | --- |
| `scripts/analyze-review-coverage.js` | Keep | Physical file inventory; reporting partitions do not infer same-show duplicates. |
| `scripts/apply-designations.js` | Keep | Per-file apply designations processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/archive-previous-scores.js` | Keep | Per-file archive previous scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/assess-review-baseline.js` | Skip (opt in) | Groups potential duplicate outlet/critic records per production. |
| `scripts/audit-aggregator-coverage.js` | Keep | Only a checkout-size count; actual coverage iterates shows.json. |
| `scripts/audit-aggregator-url-latent.js` | Keep | Per-file audit aggregator url latent processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-cloned-excerpts.js` | Skip (opt in) | scanShow pairs excerpts within a production. |
| `scripts/audit-contradicted-flag-basis.js` | Keep | Per-file audit contradicted flag basis processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-corpus-contamination.js` | Keep | byId.get(showId) already rejects non-production containers. |
| `scripts/audit-counted-review-integrity.js` | Keep | Forensic enumeration; counted-review matching decides liveness. |
| `scripts/audit-cross-attribution-by-critic.js` | Skip (opt in) | Filed-directory fingerprints need a production; replaces _pending-only filtering. |
| `scripts/audit-cross-outlet-attributions.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-cross-outlet-attributions.test.mjs` | Keep | Tests whole-corpus attribution invariants via an ESM import; preserve default enumeration. |
| `scripts/audit-cross-show-excerpt-contamination.js` | Skip (existing) | isAuditableShowDir already excludes underscore directories. |
| `scripts/audit-cross-show-url-collisions.js` | Skip (opt in) | Directory mismatch checks and URL ownership require production identity. |
| `scripts/audit-cross-show-url.js` | Skip (opt in) | A holding container is not a filed production; replaces _pending-only filtering. |
| `scripts/audit-cv-wrongproduction-lifetime.js` | Keep | Only a checkout-size count; actual checks iterate show records. |
| `scripts/audit-data-quality.js` | Keep | Duplicate detection uses reviews.json; this scan diagnoses individual fields. |
| `scripts/audit-duplicate-flag-inheritance.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-duplicate-of-cleared-contradiction.js` | Keep | Per-file audit duplicate of cleared contradiction processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-excerpt-only-backfill-queue.js` | Keep | Per-file audit excerpt only backfill queue processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-explicit-scores.js` | Keep | Per-file audit explicit scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-field-consistency.js` | Keep | Per-file audit field consistency processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-file-integrity.js` | Keep | Malformed JSON and missing fields remain relevant in archived files. |
| `scripts/audit-flag-wipe-signature.js` | Keep | Per-file audit flag wipe signature processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-flagged-file-contamination.js` | Keep | Rejected-file evidence remains useful in archives. |
| `scripts/audit-identical-text-across-critics.js` | Skip (opt in) | Text hash groups include the production directory. |
| `scripts/audit-levenshtein-matches.js` | Skip (opt in) | Pairs critics within a production before aggregating matches. |
| `scripts/audit-multi-verdict-stars.js` | Keep | Individual rating evidence, with data.showTitle fallback; no pair inference. |
| `scripts/audit-non-reviews.js` | Keep | Per-file audit non reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-orphaned-wrongprod-provenance.js` | Keep | Orphaned provenance remains relevant in archives. |
| `scripts/audit-outlet-identity-hygiene.js` | Keep | Individual outlet evidence; registry exclusion predicate decides eligibility. |
| `scripts/audit-outlet-registry.js` | Keep | Individual outlet evidence; exclusion predicate decides registry eligibility. |
| `scripts/audit-outlet-stub-rate.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-regex-patterns.js` | Keep | Superseded content is still regex evidence; retains _pending exclusion and sampling. |
| `scripts/audit-reroute-backlog.js` | Keep | guardedShowIds membership already rejects holding directories. |
| `scripts/audit-review-contamination.js` | Keep | showById lookup rejects holding directories before production checks. |
| `scripts/audit-review-content.js` | Keep | Individual content diagnostics; byShow only partitions the report. |
| `scripts/audit-review-duplicates.js` | Skip (opt in) | Keys both same-show critic groups and cross-show URL ownership by directory. |
| `scripts/audit-review-key-duplicates.js` | Skip (opt in) | Duplicate keys start with the production directory. |
| `scripts/audit-review-pair-anomalies.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-review-url-clusters.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-score-vs-models.js` | Keep | Per-file audit score vs models processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-shared-url-quote.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-sibling-title-misroute.js` | Skip (existing) | Excludes both current containers by name; preserve sibling membership checks / skippedContainerDirs reporting. |
| `scripts/audit-slug-match-routing.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-stale-cv-hash.js` | Skip (existing) | Excludes both current containers by name; preserve sibling membership checks / skippedContainerDirs reporting. |
| `scripts/audit-stale-flag-after-url-correction.js` | Keep | Per-file audit stale flag after url correction processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-stale-flag-producers.js` | Keep | Per-file audit stale flag producers processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-stale-review-texts.js` | Keep | Historical rejection evidence uses the record showId/showTitle for title lookup. |
| `scripts/audit-stale-score-input.js` | Keep | Per-file audit stale score input processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-stale-slot-squatters.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-stuck-rescore-flags.js` | Keep | Per-file audit stuck rescore flags processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-truncated-reviews.js` | Keep | Per-file audit truncated reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-uncollected-live-reviews.js` | Keep | assessShow runs only on shows.json entries, not holding containers. |
| `scripts/audit-unknown-outlets.js` | Keep | Per-file audit unknown outlets processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-url-collisions.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/audit-url-downgrade.js` | Keep | Per-file audit url downgrade processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/audit-url-validation.js` | Keep | showMap lookup already rejects holding directories. |
| `scripts/audit-wrong-production-reviews.js` | Keep | Historical individual production flags and diagnostic counts; no pair inference. |
| `scripts/audit-wrong-production.js` | Keep | Production checks require show metadata; byShow partitions findings. |
| `scripts/backfill-contamination-allow-signals.js` | Keep | Per-file backfill contamination allow signals processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-critic-name-truncation.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/backfill-critics-archive-org.js` | Keep | Per-file backfill critics archive org processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-extractor-rescore.js` | Keep | Per-file backfill extractor rescore processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-html-override-rename.js` | Keep | Per-file backfill html override rename processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-llm-dates.js` | Keep | Per-file backfill llm dates processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-london-theatre-stars.js` | Keep | Per-file backfill london theatre stars processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-normalized-scores.js` | Keep | Per-file backfill normalized scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-original-scores.js` | Keep | Per-file backfill original scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-outlet-from-sitemap.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/backfill-pv-critics.js` | Keep | Per-file backfill pv critics processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-review-dates.js` | Keep | Per-file backfill review dates processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-serp-abandonment.js` | Keep | Per-file backfill serp abandonment processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-text-dates.js` | Keep | Per-file backfill text dates processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-text-fetched-at.js` | Keep | Per-file backfill text fetched at processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-unknown-critics.js` | Keep | Per-file backfill unknown critics processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backfill-url-dates.js` | Keep | Per-file backfill url dates processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/backup-llm-scores.js` | Keep | Per-file backup llm scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/build-calibration-set.js` | Keep | Per-file build calibration set processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/check-nyt-critics-pick.js` | Keep | Per-file check nyt critics pick processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/check-score-integrity.js` | Keep | Per-file check score integrity processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/classify-review-quality.js` | Keep | Per-file classify review quality processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/classify-unscored-blocked-url.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/classify-unscored-news-articles.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/classify-wrong-show.js` | Keep | Per-file classify wrong show processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/clean-ocr-extract.js` | Keep | Per-file clean ocr extract processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/clean-timeout-junk.js` | Keep | Per-file clean timeout junk processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/cleanup-dedup-comprehensive.js` | Skip (opt in) | Alias merges and URL dedup compare records per production. |
| `scripts/cleanup-duplicate-reviews.js` | Skip (opt in) | Normalized outlet/critic merges compare one production. |
| `scripts/cleanup-fake-publish-dates.js` | Keep | Per-file cleanup fake publish dates processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/cleanup-known-issues.js` | Keep | Per-file cleanup known issues processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/cleanup-phantom-outlets.js` | Skip (opt in) | Phantom merges and affected-show counts need production identity. |
| `scripts/cleanup-review-cruft.js` | Skip (opt in) | Critic groups and sibling outlet checks assume one production. |
| `scripts/cleanup-review-sources.js` | Skip (opt in) | Filter loadAllReviews for same-show dedup; keep the separate .tmp cleanup scan. |
| `scripts/clear-stale-automated-text-verdicts.js` | Keep | Per-file clear stale automated text verdicts processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/clear-stale-roundup-flags.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/clear-wrong-show-blockers.js` | Keep | Per-file clear wrong show blockers processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/collect-good-outlets.js` | Keep | Per-file collect good outlets processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/collect-review-texts-v2.js` | Keep | Per-file collect review texts v2 processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/collect-review-texts.js` | Keep | Per-file collect review texts processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/collect-showscore-reviews.js` | Keep | Per-file collect showscore reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/collection-coverage-dashboard.js` | Keep | Physical file inventory; reporting partitions do not infer same-show duplicates. |
| `scripts/comprehensive-score-audit.js` | Keep | Per-file comprehensive score audit processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/compress-existing-images.js` | Keep | Image-tree inventory; not review-text holding storage. |
| `scripts/detect-critic-typos.js` | Keep | Per-file detect critic typos processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/detect-cross-outlet-duplicates.js` | Skip (opt in) | Compares text and duplicate pointers within one production. |
| `scripts/detect-ob-closings.js` | Keep | Unused helper import; there is no call to change. |
| `scripts/detect-syndicated-duplicates.js` | Skip (opt in) | Compares syndicated review pairs within one production. |
| `scripts/diagnostic-p0-score-audit.js` | Keep | Per-file diagnostic p0 score audit processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/discover-dailymail-urls.js` | Skip (opt in) | Same-show URL allocation must not conflate archived productions under --all-markets. |
| `scripts/discover-real-urls.js` | Keep | Per-file discover real urls processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/eval-v52.js` | Keep | Per-file eval v52 processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/exclusion-rule-census.js` | Keep | Per-file exclusion rule census processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/extract-embedded-grades.js` | Keep | Per-file extract embedded grades processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/extract-explicit-ratings.js` | Keep | Per-file extract explicit ratings processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/extract-pull-quotes.js` | Keep | Per-file extract pull quotes processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/extract-scores-from-archives.js` | Keep | Per-file extract scores from archives processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/extract-unique-outlets.js` | Keep | Per-file extract unique outlets processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/extract-we-star-ratings.js` | Keep | Per-file extract we star ratings processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fetch-from-wayback.js` | Keep | Per-file fetch from wayback processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fetch-guardian-reviews.js` | Keep | Per-file fetch guardian reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fetch-nysr-scores.js` | Keep | Per-file fetch nysr scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fetch-review-texts.js` | Keep | Per-file fetch review texts processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/find-duplicate-reviews.js` | Skip (opt in) | Exact and similar critic groups are constructed per production. |
| `scripts/find-duplicate-urls.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/find-free-outlets.js` | Keep | Per-file find free outlets processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/find-orphan-image-dirs.js` | Keep | Per-file find orphan image dirs processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/find-review-urls.js` | Keep | Per-file find review urls processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/find-scrapable-reviews.js` | Keep | Per-file find scrapable reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/find-url-owners.js` | Keep | Forensic lookup should find every URL holder, including archived ones. |
| `scripts/fix-aggregator-gap-override-contamination.js` | Keep | Per-file fix aggregator gap override contamination processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-canonical-duplicate-backpointer.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/fix-contaminated-images.js` | Keep | Image hashes and revival checks use a different tree from review holdings. |
| `scripts/fix-contaminated-reviews.js` | Keep | Per-file fix contaminated reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-critic-name-duplicates.js` | Skip (opt in) | Pair matching and merging use the production directory. |
| `scripts/fix-critic-typos.js` | Skip (opt in) | Frequency selection and same-outlet typo merges need production records. |
| `scripts/fix-default-scores.js` | Keep | Per-file fix default scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-domain-mismatched-outlets.js` | Skip (opt in) | The sibling canonical-outlet file must be from the same production. |
| `scripts/fix-duplicates-and-zeros.js` | Skip (opt in) | Per-directory outlet/critic groups can delete supposed duplicates. |
| `scripts/fix-excerpt-as-fulltext.js` | Keep | Per-file fix excerpt as fulltext processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-garbage-reviews.js` | Keep | Per-file fix garbage reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-garbage-scores.js` | Keep | Per-file fix garbage scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-nav-contaminated.js` | Keep | Per-file fix nav contaminated processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-non-review-misclassifications.js` | Keep | Per-file fix non review misclassifications processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-null-dates.js` | Keep | Per-file fix null dates processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-nysr-scores.js` | Keep | Per-file fix nysr scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-outlet-case.js` | Keep | Per-file fix outlet case processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-p0-score-corruption.js` | Keep | Per-file fix p0 score corruption processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-remaining-domain-mismatches.js` | Keep | Per-file fix remaining domain mismatches processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-theatre-reviews-star-ratings.js` | Keep | Per-file fix theatre reviews star ratings processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-timeout-and-invalid.js` | Keep | Per-file fix timeout and invalid processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-timeout-we-attribution.js` | Keep | Per-file fix timeout we attribution processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-unflagged-same-url-clusters.js` | Skip (opt in) | Same-URL canonical selection is per production; generalizes the two-container exclusion. |
| `scripts/fix-unknown-critics.js` | Keep | Per-file fix unknown critics processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/fix-url-duplicates-same-show.js` | Skip (opt in) | Directory identity supplies the same-show merge boundary. |
| `scripts/flag-junk-url-reviews.js` | Keep | Per-file flag junk url reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/flag-rescore-needed.js` | Keep | Per-file flag rescore needed processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/flag-single-model-for-rescore.js` | Keep | Per-file flag single model for rescore processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/flag-we-cross-production.js` | Keep | Per-file flag we cross production processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/flag-wrong-production-by-date.js` | Keep | Per-file flag wrong production by date processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/flag-wrong-production-by-url-date.js` | Keep | Per-file flag wrong production by url date processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/flag-wrong-production-pending.js` | Keep | Per-file flag wrong production pending processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/gap-analysis-outlets.js` | Keep | Per-file gap analysis outlets processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/gather-reviews.js` | Keep | Per-file gather reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/generate-integrity-report.js` | Skip (opt in) | Duplicate metric must match audit-review-key-duplicates. |
| `scripts/heal-outlet-mismatch.js` | Keep | Per-file heal outlet mismatch processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/health-check-urls.js` | Keep | Per-file health check urls processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/health-check.js` | Keep | Per-file health check processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/helpers/check-coverage.js` | Keep | Physical file inventory; reporting partitions do not infer same-show duplicates. |
| `scripts/helpers/shows-needing-scoring.js` | Keep | Per-file shows needing scoring processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/identify-unknown-outlets.js` | Keep | Per-file identify unknown outlets processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/isolate-multi-show-sections.js` | Keep | Per-file isolate multi show sections processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/kimi-dry-run.js` | Keep | Per-file kimi dry run processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/lib/critic-review-scan.js` | Keep | Individual critic registry evidence remains useful in archived records. |
| `scripts/lib/critic-spelling-duplicates.js` | Skip (existing) | BRO-5740 already excludes all underscore directories; acceptance passes on main, unchanged. |
| `scripts/lib/list-show-dirs.test.mjs` | Keep | Tests the helper or whole-corpus invariants; preserve default enumeration. |
| `scripts/lib/opening-night-checks/lifetime-sweep-runner.js` | Keep | Only checkout-size inventory; actual checks iterate separate show records. |
| `scripts/lib/rebuild-staleness-scan.js` | Skip (existing) | Already excludes underscore candidate show IDs independently of the inventory. |
| `scripts/lib/rescore-queue-depth.js` | Keep | Per-file rescore queue depth processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/lib/review-guards.explain.test.mjs` | Keep | Tests the helper or whole-corpus invariants; preserve default enumeration. |
| `scripts/lib/review-texts-preflight.js` | Keep | Checkout-size inventory; preserve its existing minimum-size policy, outside pair grouping. |
| `scripts/lib/review-validation-scope.js` | Keep | Snapshots must detect changes in archived fingerprints too. |
| `scripts/lib/silent-exclusion-detectors.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/lib/star-score-mismatch.js` | Keep | Rating-band evidence remains relevant in individual archived records. |
| `scripts/lib/wrongshow-autoclear-ensemble.test.mjs` | Keep | Tests the helper or whole-corpus invariants; preserve default enumeration. |
| `scripts/list-unscored.js` | Keep | Physical file inventory; reporting partitions do not infer same-show duplicates. |
| `scripts/llm-scoring/calibration.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/comparative-rescore.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/comprehensive-experiment.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/evaluate.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/model-comparison-experiment.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/status.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/test-consistency.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/test-prompt-structural-ab.ts` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/llm-scoring/test-prompt-variations.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/llm-scoring/validation.ts` | Keep | Per-review model evaluation or sampling; no within-directory pair inference. |
| `scripts/mark-excerpt-scores.js` | Keep | Per-file mark excerpt scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/mark-uncalculated-reviews.js` | Keep | Per-file mark uncalculated reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/migrate-aggregator-originalscores.js` | Keep | Per-file migrate aggregator originalscores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/migrate-content-tiers.js` | Keep | Per-file migrate content tiers processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/migrate-outlet-ids.js` | Keep | Per-file migrate outlet ids processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/migrate-reroute-backlog.js` | Keep | Per-file migrate reroute backlog processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/migrate-ss-score-labels.js` | Keep | Per-file migrate ss score labels processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/migrations/sync-content-tier-reason-2026-10.js` | Keep | Per-file sync content tier reason 2026 10 processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/one-off/audit-wp-cv-valid.js` | Keep | Per-file audit wp cv valid processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/plan-key-duplicate-fixes.js` | Skip (opt in) | Repair plans must only compare records of one production. |
| `scripts/re-ensemble-scores.ts` | Keep | Per-file re ensemble scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/rebuild-all-reviews.js` | Keep | Existing known-show lookup controls rebuild eligibility; preserve scoring scope. |
| `scripts/reclassify-invalid-reviews.js` | Keep | Per-file reclassify invalid reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/reclean-truncated.js` | Keep | Per-file reclean truncated processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/recollect-for-scores.js` | Keep | Per-file recollect for scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/reconcile-scores.js` | Keep | Per-file reconcile scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/reconcile-source-scores.js` | Keep | Per-file reconcile source scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/record-arm-yield.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/recover-explicit-ratings.js` | Keep | Per-file recover explicit ratings processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/recover-login-page-reviews.js` | Keep | Per-file recover login page reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/recover-null-dates.js` | Keep | Per-file recover null dates processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/recover-wsj-browser.js` | Keep | Per-file recover wsj browser processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/recover-wsj-subscriber.js` | Keep | Per-file recover wsj subscriber processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/rediscover-review-urls.js` | Keep | Per-file rediscover review urls processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/regenerate-tier-configs.js` | Keep | Per-file regenerate tier configs processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/remove-placeholder-images.js` | Keep | Image-tree inventory; not review-text holding storage. |
| `scripts/repair-implausible-redirects.js` | Keep | Per-file repair implausible redirects processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/repair-page-bleed.js` | Keep | Per-file repair page bleed processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/report-review-drift-details.js` | Skip (opt in) | Opt in only for dups; forensic classes keep archive evidence. |
| `scripts/retry-stale-wrong-production.js` | Keep | Per-file retry stale wrong production processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/retry-wrong-urls.js` | Keep | Per-file retry wrong urls processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/reverify-promoted-reviews.js` | Keep | Per-file reverify promoted reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/scan-we-cross-market.ts` | Keep | Per-file scan we cross market processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/score-all-unscored.js` | Keep | Per-file score all unscored processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/score-final-unscored.js` | Keep | Per-file score final unscored processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/score-remaining-reviews.js` | Keep | Per-file score remaining reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/score-reviews-calibrated.js` | Keep | Per-file score reviews calibrated processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/score-reviews-llm.js` | Keep | Per-file score reviews llm processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/scoring-delta.js` | Keep | Preserve existing replay scope, including historical exclusion evidence. |
| `scripts/scrape-priority-reviews.js` | Keep | Per-file scrape priority reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/split-multi-show-roundups.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/strip-stale-single-model-scores.js` | Keep | Per-file strip stale single model scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/strip-variety-promo-bleed.js` | Keep | Per-file strip variety promo bleed processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/sweep-false-positive-wrong-production.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/sweep-rss-pending-junk.js` | Keep | Root is _pending itself; its children are actual production directories. |
| `scripts/sweep-wrongproduction-corroboration.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `scripts/sync-review-texts.js` | Keep | Per-file sync review texts processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/test-consistency.js` | Keep | Per-file test consistency processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/test-content-verifier.js` | Keep | Per-file test content verifier processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/test-metadata-reset.js` | Keep | Per-file test metadata reset processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/test-quality-all-unscored.js` | Keep | Per-file test quality all unscored processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/test-scoring-rejection-logs.js` | Keep | Per-file test scoring rejection logs processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/test-unknown-dedup.js` | Keep | Per-file test unknown dedup processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/triage-unknown-critic-stubs.js` | Keep | Per-file triage unknown critic stubs processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/unabandon-fetch-cycles.js` | Keep | Per-file unabandon fetch cycles processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/unabandon-non-serp-cycles.js` | Keep | Per-file unabandon non serp cycles processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/unflag-wrong-production-fps.js` | Keep | Per-file unflag wrong production fps processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/update-review-urls.js` | Keep | Per-file update review urls processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/validate-data.js` | Keep | Multiple roots: images, archives and reviews; each check supplies eligibility rules. |
| `scripts/validate-scores.js` | Keep | Per-file validate scores processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/verify-existing-reviews.js` | Keep | Per-file verify existing reviews processing; no within-directory pair inference. Preserve existing scope. |
| `scripts/video-reviews/build-video-reviews.js` | Keep | Transcript-root inventory excludes raw/classified under its own storage contract. |
| `scripts/video-reviews/score-video-reviews.js` | Keep | Transcript-root inventory uses its own EXCLUDE set. |
| `scripts/video-reviews/verify-productions.js` | Keep | Transcript-root inventory excludes raw/classified under its own storage contract. |
| `scripts/wp-classifier-parity.js` | Skip (existing) | Already excludes underscore directories before production comparisons. |
| `tests/acceptance/variety-promo-bleed.test.mjs` | Keep | Tests the helper or whole-corpus invariants; preserve default enumeration. |
