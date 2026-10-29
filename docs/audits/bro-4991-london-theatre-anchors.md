# BRO-4991: London Theatre anchor verification

## Pending correction plan on 2026-10-29

`data/pending-fixes/bro-4991.json` now contains 14 `review-field-edit` actions for the page-verified stars in the table below. Each compares against the current missing/null `originalScore`. The existing executor calls `applyVerifiedOriginalScore()`, which writes the complete verified rating field set. The plan is pending, not applied. No private data, exclusion flags, or workflows changed.

The initial real-data replay reproduced an additional bug: despite passing the executor's preflight, all 14 manual-verified ratings became hard no-star violations in the integrity checker. The shared `publishesNoCriticRating()` predicate exempted only automatic page-data ratings. Its classification now also honors `isHumanVerifiedRating()`, the same verified provenance the writer protects. This fixes the shared classification used by the audit and collection discard path. Generic extraction, missing provenance, and relayed stars remain refused. Five regression assertions failed before this change; the new tests call the real verified-rating writer and discard helper. A corpus comparison of the old and new predicate changes 0 of the 64,155 existing records; only the 14 planned verified corrections gain the exemption in the replay.

The generator's preflight replayed all 14 actions successfully through `executeReviewFieldEditIn()` and the real write guard. A second replay on copies of the real show directories changed exactly 14 review records. All 14 stored anchor bands agree with their verified critic stars. No LLM score, effective `getBestScore()` result, human score, sibling record, or excluded record changed. Examples: Psychosis gains 4/5 and stays at 79; Bleak Expectations gains 2/5 and stays at 37; Kimberly Akimbo gains 4/5 and keeps its human score of 80.

The full integrity checker was run before and after the replay against the same 64,155-file corpus:

| Measurement | Original corpus | After plan replay on copies |
| --- | --- | --- |
| No-star outlet with originalScore | 0 | 0 |
| Aggregator source without scoreSource | 171, including 0 London Theatre | 171, including 0 London Theatre |
| London Theatre rows stamped anchored-v6 | 223 | 209 |
| Confirmed rows still stamped anchored-v6 | 182 | 182 |
| Known band mismatches | 0 | 0 |
| Unverified rows still stamped anchored-v6 | 41 | 27 |

The audit's anchored-v6 total drops because the verified-rating writer stamps `scoreSource: manual-verified`. This is not a rescore. Comparing the unchanged bands against the newly verified stars separately confirms all 14 repaired rows. The live private corpus remains unchanged until the runner applies the plan.

The original Noises Off placeholders remain repaired with page-sourced 4/5 and 5/5 stars, respectively, and remain excluded as wrongProduction. The card's acceptance command already passed before these changes. At the start, `git diff --name-only origin/main -- scripts` was empty, so the tested script code matched the main ref in this checkout. `git log -S 'originalScore' --oneline -5 -- scripts/lib/no-rating-outlet-score.js` and the history search for `ratingVerificationQueue` both return `e08ba643` in this checkout.

The generator wrote the plan but could not stage it: `fatal: Unable to create '/home/user/Broadwayscore/.git/worktrees/codex-runner/index.lock': Read-only file system`. A narrow `.gitignore` exception makes this public plan visible to the runner without changing the Git index. The generator and replay were explicitly pointed at this checkout's runner-provided data, rather than their default sibling clones. All temporary copies were deleted.

### Remaining URL repairs and evidence

Both requested source URL edits are refused by the existing `review-field-edit` validator with `url: the current url is not provably wrong (aggregator, non-review page, another critic's review, another show's review, or an unverified legacy web-search url)`. Dr Strangelove has a null URL; High Society's cast-news URL is not recognized by that validator's non-review patterns. An attempted 15-action plan reported 14/15 applied cleanly. Its URL action was removed, and the final 14-action plan passes. Neither URL was changed and the validator was not broadened. Both rating actions retain their correct review evidence URLs in their descriptions. These URL repairs still require a correction path that supports them:

- [Dr Strangelove review](https://www.londontheatre.co.uk/reviews/dr-strangelove-review-noel-coward-theatre), Marianka Swain, 29 October 2024.
- [High Society review](https://www.londontheatre.co.uk/reviews/high-society-review-barbican), Marianka Swain, 4 June 2026. A future URL repair must account for the URL invariant clearing old URL-derived text and scores, then refetch the correct review and retain its verified 4/5 rating.

The five previously unresolved active rows remain untouched. Primary candidates were found for [ABBA Voyage](https://www.londontheatre.co.uk/reviews/abba-voyage-review-abba-arena) (Sophie Thomas, 6 January 2023), [Cabaret](https://www.londontheatre.co.uk/reviews/cabaret-at-the-kit-kat-club-review-eddie-redmayne-and-jessie-buckley) (Suzy Evans, 13 December 2021), and [Magic Mike Live](https://www.londontheatre.co.uk/reviews/channing-tatum-magic-mike-live-hippodrome-casino) (Suzy Evans, 25 January 2022). The ABBA and Cabaret pages describe their own reviews as five-star and four-star, respectively; London's [Magic Mike ticket page](https://www.londontheatre.co.uk/show/16563-magic-mike-live-tickets) links a four-star critic review. These unknown-critic records have no URL or fullText to tie them to a particular article, and Magic Mike has another review by Mark Shenton. A candidate article alone does not establish record identity. No rating or byline was inferred from a relay, previous score, or URL.

The Drifters Girl's stored review remains inaccessible via the browser tool; The Hunger Games' stored review still redirects to its ticket page. Neither observation proves that the critic originally printed no rating. Recover archived primary evidence before rescoring.

The current queue has 19 excluded rows and 22 other rows, including the 14 in the plan. The prior worklist's excluded `the-producers-west-end-2025/london-theatre--unknown.json` is no longer in the queue. Three other unresolved rows now appear: Sylvia / Marianka Swain (band 51-70, score 60), The Lehman Trilogy / Anya Ryan (71-90, 86), and The Producers / Olivia Rook (51-70, 68). They need primary-rating verification too; this plan does not expand to undocumented ratings or change any of the earlier excluded rows.

Recurring cost added: 0 paid fetches, LLM calls, or API calls per run. The plan queues no fetching or scoring and changes no cron. This investigation used browser searches and page opens only; it did not invoke the scraper or scorer. Existing wiring remains `execute-approved-fix.yml` to `scripts/execute-approved-fix.js` to `executeReviewFieldEditIn()` to `applyVerifiedOriginalScore()`.

### Verification of the pending plan and classification fix

- `node --test --test-timeout 300000 scripts/lib/score-extractors.test.mjs`: before the predicate fix, 32 passed and 5 failed; after, all 37 passed as part of the focused command below.
- `node --test --test-timeout 300000 scripts/lib/score-extractors.test.mjs scripts/lib/no-rating-outlet-score.test.mjs scripts/lib/review-field-edit.test.mjs scripts/lib/verified-original-score.test.mjs scripts/lib/london-theatre-anchor-audit.test.mjs tests/unit/pending-fix-plans.test.mjs`: 129 passed, 0 failed.
- `rg -l 'score-extractors' tests scripts --glob '*.test.*'` selected the direct dependent tests. The other 29 files ran with `node --test --test-concurrency=4 --test-timeout 300000`: 635 tests passed; the TypeScript file failed to resolve its extensionless import under plain Node. Its header specifies the tsx lane. `node_modules/.bin/tsx --test --test-timeout 300000 tests/unit/letter-grade-parity.test.ts` passed all 4 tests. No implementation assertion failed in the dependent files.
- `node --test --test-timeout 300000 scripts/check-score-integrity.test.mjs`: 6 passed, 0 failed.
- `node --test --test-timeout 300000 scripts/lib/no-rating-outlet-score.test.mjs`: final acceptance rerun, 5 passed, 0 failed.
- `REVIEW_TEXTS_DIR="$PWD/data/review-texts" node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-4991.json`: 14/14 applied cleanly to temporary copies.
- `node scripts/scoring-delta.js`: score-source phase, 63,942 reviews processed; SCORE CHANGED: 0 reviews across 0 shows; T1 outlet flips: 0 (inclusion: 0, score: 0). Delta within tolerance.
- `node scripts/test-temporal-override-regression.js`: OVERALL PASS, both suites green (exit 0).
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`: all gates green, lint-workflows exit 0; actionlint is not installed here. Read `/tmp/gauntlet/lint-workflows.log` before removing the temporary output.
- `git diff --check`: passed. No TypeScript source files changed, so tsc was not run.

## Corpus results on 2026-10-24

The acceptance test already passes on main (HEAD and origin/main: `29767beecf3f3d8119d09bf6a086c8cfe3225d24`). No scoring or audit code change is needed for the previously landed fix.

`node scripts/check-score-integrity.js` scans 59,616 files and reports:

- 208 London Theatre `anchored-v6` rows: 169 confirmed from stored provenance, 0 known mismatches, 39 needing rating verification.
- 0 aggregator scores in P0 and 0 no-star outlet scores.
- 173 aggregator-source rows without scoreSource, below the card's 203 baseline; 0 from London Theatre.
- Both Noises Off placeholders are already replaced: Marianka Swain has `4/5 stars` and Mark Shenton has `5/5 stars`, sourced from `londontheatre-page-json`. Both still have `wrongProduction: true`; this investigation does not clear exclusions.

The previous 2026-10-21 inventory had 184 anchored rows, 146 confirmed and 38 unverified. Today's additional unresolved row is Young Frankenstein / Mark Shenton. Counts changed with the corpus, before this investigation.

## Live rating verification on 2026-10-24

14 of the 39 outstanding bands now agree with primary-source critic stars. Their stored LLM scores also fall inside those bands. There are no mismatches in this sample. The existing `extractLondonTheatreRating()` reads the article's own `pageContent.ourCriticsRating`; related articles and product/audience ratings are not evidence.

These are documented confirmations, not private-data writes. The 39-row machine worklist remains unchanged until verified provenance is stored. Adding the 14 observed ratings in memory confirms their prior bands; it does not change any LLM score. In that comparison, 183 rows would be confirmed and 25 unverified. The real audit before and after this documentation change remains 169 confirmed, 0 mismatches, 39 unverified. Review records changed: 0.

| Review file, relative to data/review-texts | Critic star | Existing band; score | Primary evidence | Follow-up |
| --- | --- | --- | --- | --- |
| `4-48-psychosis-west-end-2025/london-theatre--holly-omahony.json` | 4/5 | 71-90; 79 | [Review](https://www.londontheatre.co.uk/reviews/4-48-psychosis-review-royal-court) | Same stored URL |
| `bleak-expectations-west-end-2023/london-theatre--matt-wolf.json` | 2/5 | 31-50; 37 | [Review](https://www.londontheatre.co.uk/reviews/bleak-expectations-west-end-review) | Same stored URL |
| `cuckoo-west-end-2023/london-theatre--matt-wolf.json` | 4/5 | 71-90; 82 | [Review](https://www.londontheatre.co.uk/reviews/cuckoo-review-royal-court) | Same stored URL |
| `dancing-at-lughnasa-west-end-2023/london-theatre--marianka-swain.json` | 5/5 | 91-100; 96 | [Review](https://www.londontheatre.co.uk/reviews/dancing-at-lughnasa-review-national-theatre) | Same stored URL |
| `dr-semmelweis-west-end-2023/london-theatre--marianka-swain.json` | 4/5 | 71-90; 89 | [Review](https://www.londontheatre.co.uk/reviews/dr-semmelweis-review-harold-pinter-theatre) | Same stored URL |
| `dr-strangelove-west-end-2024/london-theatre--marianka-swain.json` | 4/5 | 71-90; 89 | [Review](https://www.londontheatre.co.uk/reviews/dr-strangelove-review-noel-coward-theatre) | Repair source URL |
| `high-society-west-end-2026/london-theatre--marianka-swain.json` | 4/5 | 71-90; 87 | [Review](https://www.londontheatre.co.uk/reviews/high-society-review-barbican) | Repair source URL |
| `kimberly-akimbo-off-west-end-2026/london-theatre--marianka-swain.json` | 4/5 | 71-90; 81 | [Review](https://www.londontheatre.co.uk/reviews/kimberly-akimbo-review-hampstead-theatre) | Preserve human score 80 |
| `mad-house-west-end-2022/london-theatre--sophie-thomas.json` | 5/5 | 91-100; 96 | [Review](https://www.londontheatre.co.uk/reviews/mad-house-review-ambassadors-theatre-david-harbour) | Same stored URL |
| `medea-west-end-2023/london-theatre--marianka-swain.json` | 4/5 | 71-90; 82 | [Review](https://www.londontheatre.co.uk/reviews/medea-review-soho-place-theatre) | Same stored URL |
| `the-great-british-bake-off-musical-west-end-2023/london-theatre--marianka-swain.json` | 4/5 | 71-90; 81 | [Review](https://www.londontheatre.co.uk/reviews/the-great-british-bake-off-musical-review-noel-coward-theatre) | Same stored URL |
| `the-other-place-west-end-2024/london-theatre--holly-omahony.json` | 3/5 | 51-70; 66 | [Review](https://www.londontheatre.co.uk/reviews/the-other-place-review-national-theatre) | Same stored URL |
| `the-prince-of-egypt-west-end-2020/london-theatre--mark-shenton.json` | 2/5 | 31-50; 32 | [Review](https://www.londontheatre.co.uk/reviews/review-the-prince-of-egypt-at-the-dominion-theatre) | Same stored URL |
| `young-frankenstein-west-end-2017/london-theatre--mark-shenton.json` | 5/5 | 91-100; 97 | [Review](https://www.londontheatre.co.uk/reviews/review-mel-brooks-young-frankenstein-at-the-garrick-theatre) | Same stored URL |

The 11 rows with the same stored URL were checked directly using the existing backfill CLI, in dry-run mode. For each corresponding show ID in the table, run:

`node scripts/backfill-london-theatre-stars.js --show=<show-id> --limit=1 --delay-ms=0`

Each returned `candidates=1, fetched=1, rated=1, written=0, errors=0`. Star values are recorded above. All 14 observations were then passed through the real `applyRating()` and `auditLondonTheatreAnchor()` helpers in memory, retaining the original anchored scoreSource only for comparison. All returned `confirmed`; stored llmScore and humanReviewScore were preserved. This comparison does not simulate write-guard persistence or claim a private-data repair.

Three additional page checks used throwaway copies inside this checkout, deleted afterwards:

- Dr Strangelove: its stored URL is null. The linked review names Marianka Swain and is dated 29 October 2024, matching the stored byline/date; its opening paragraph also matches the stored text. Substituting that evidence URL only in a temporary copy lets the existing backfill observe 4/5.
- High Society: its stored URL points to a cast-news article. The linked review names Marianka Swain, is dated 4 June 2026, and its opening paragraph matches the stored text. Substituting that review URL only in a temporary copy yields 4/5. Repair the source URL through the existing private-data correction path before treating the record as repaired.
- Kimberly Akimbo: the live byline/date and opening paragraph match the stored text. The backfill normally skips its humanReviewScore=80. For rating observation only, a temporary copy omitted that override and yielded 4/5. The real human override was never changed and must remain in place; do not queue it for rescoring.

## Remaining evidence and exclusions

25 rows remain without a verified critic star: 20 already excluded (16 wrongProduction, 1 wrongShow, 3 duplicateOf), 3 missing URLs, and 2 unavailable review pages. Do not rescore excluded rows or infer a critic's rating from the prior band or a relay. An unavailable review page does not establish that the critic originally printed no rating.

| Review file, relative to data/review-texts | Existing band; score | Status |
| --- | --- | --- |
| `a-night-with-janis-joplin-2013/london-theatre--matt-wolf.json` | 51-70; 65 | Excluded: wrongProduction; skip |
| `abba-voyage-off-west-end-2026/london-theatre--sophie-thomas.json` | 91-100; 97 | Excluded: wrongProduction; skip |
| `abba-voyage-off-west-end-2026/london-theatre--unknown.json` | 91-100; 96 | Missing URL; identify primary review first |
| `bengal-tiger-at-the-baghdad-zoo-2011/london-theatre--matt-wolf.json` | 71-90; 80 | Excluded: wrongProduction; skip |
| `black-is-the-color-of-my-voice-west-end-2026/london-theatre--unknown.json` | 71-90; 82 | Excluded: wrongShow; skip |
| `cabaret-at-the-kit-kat-club-west-end-2021/london-theatre--chris-omaweng.json` | 71-90; 83 | Excluded: duplicateOf; skip |
| `cabaret-at-the-kit-kat-club-west-end-2021/london-theatre--unknown.json` | 71-90; 84 | Missing URL; identify primary review first |
| `clybourne-park-2012/london-theatre--matt-wolf.json` | 71-90; 79 | Excluded: wrongProduction; skip |
| `coming-clean-west-end-2020/london-theatre--mark-shenton.json` | 71-90; 79 | Excluded: wrongProduction; skip |
| `giant-west-end-2025/london-theatre--julia-rank.json` | 51-70; 54 | Excluded: wrongProduction; skip |
| `hadestown-west-end-2024/london-theatre--will-longman.json` | 51-70; 68 | Excluded: wrongProduction; skip |
| `machinal-2014/london-theatre--olivia-rook.json` | 71-90; 80 | Excluded: wrongProduction; skip |
| `magic-mike-live-west-end-2021/london-theatre--unknown.json` | 71-90; 71 | Missing URL; identify primary review first |
| `my-neighbour-totoro-west-end-2025/london-theatre--unknown.json` | 91-100; 99 | Excluded: duplicateOf; skip |
| `oleanna-2009/london-theatre--matt-wolf.json` | 51-70; 61 | Excluded: wrongProduction; skip |
| `passing-strange-2008/london-theatre--marianka-swain.json` | 71-90; 81 | Excluded: wrongProduction; skip |
| `punch-west-end-2025/london-theatre--anya-ryan.json` | 71-90; 85 | Excluded: wrongProduction; skip |
| `rock-n-roll-2007/london-theatre--matt-wolf.json` | 71-90; 76 | Excluded: wrongProduction; skip |
| `the-brightening-air-west-end-2025/london-theatre--unknown.json` | 51-70; 66 | Excluded: duplicateOf; skip |
| `the-drifters-girl-west-end-2021/london-theatre--marianka-swain.json` | 51-70; 64 | Stored page gone; recover primary evidence |
| `the-estate-west-end-2025/london-theatre--theo-bosanquet.json` | 71-90; 81 | Excluded: wrongProduction; skip |
| `the-hunger-games-on-stage-west-end-2025/london-theatre--marianka-swain.json` | 31-50; 36 | Redirects to ticket page; rating not established |
| `the-phantom-of-the-opera-west-end-1986/london-theatre--julia-rank.json` | 71-90; 87 | Excluded: wrongProduction; skip |
| `the-phantom-of-the-opera-west-end-1986/london-theatre--theo-bosanquet.json` | 71-90; 87 | Excluded: wrongProduction; skip |
| `the-producers-west-end-2025/london-theatre--unknown.json` | 51-70; 69 | Excluded: wrongProduction; skip |

The Drifters Girl dry run returned `fetched=1, gone=1, rated=0, written=0, errors=0`. The Hunger Games returned `fetched=1, noRating=1, rated=0, written=0, errors=0`; the [stored review URL](https://www.londontheatre.co.uk/reviews/the-hunger-games-review-troubadour-canary-wharf-theatre) now redirects to the show's ticket page. Search did not establish replacement primary reviews. Recover archived primary evidence before deciding whether either needs an unanchored rescore.

## Writer, wiring, and private-data handoff

The existing writer is `scripts/llm-scoring/ensemble-scorer.ts`: it uses `detectBandFromReviewFile()`, then writes `scoreSource: anchored-v6` and `llmScore.band`. The London Theatre star writer is `scripts/lib/london-theatre-stars-backfill.js:applyRating()`, called by `scripts/backfill-london-theatre-stars.js`; collection also uses the dedicated extractor. No downstream reader was patched.

`scripts/check-score-integrity.js` calls `auditLondonTheatreAnchor()` before skipping missing/cleared original ratings. Its existing weekly-integrity workflow caller runs on Sundays at 03:00 UTC. The queues are advisory and do not schedule scoring automatically.

Private follow-up: persist the 14 observed stars with verified provenance, repair the two identified source URLs, preserve the Kimberly Akimbo override, and recover evidence for the five remaining non-excluded rows. The review-field-edit allowlist now supports originalScore through `applyVerifiedOriginalScore()`, so no new allowlist entry or run-script is necessary. Use the existing private-data correction process; this worker cannot write the review-texts clone or dispatch a landing workflow. If new evidence gives a different star band, the existing `flag-late-star-reanchor.js` caller of `needsLateStarReanchor()` handles eligible stale bands. No private correction plan was applied.

## Verification and cost

- `node --test scripts/lib/no-rating-outlet-score.test.mjs`: 5 passed on unchanged main before investigation.
- `node --test --test-timeout 300000 scripts/lib/no-rating-outlet-score.test.mjs scripts/lib/london-theatre-anchor-audit.test.mjs scripts/check-score-integrity.test.mjs tests/unit/london-theatre-page-rating.test.mjs`: 32 passed, 0 failed.
- Real-data backfill dry runs: 16 page fetches in the complete verification pass (14 ratings, 1 gone page, 1 ticket-page redirect); 0 private writes. Two earlier sample dry runs repeated the Psychosis and Bleak Expectations fetches. An initial Kimberly Akimbo run correctly skipped its human override.
- The shared fetchPage probe failed for three pages: `All scraping methods failed`, because the Playwright executable is absent at `/opt/pw-browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`. Existing backfill dry runs supplied the HTML-based rating checks without installing anything.
- Additional paid fetches, LLM calls, or production API calls introduced per run: 0. Session checks used 18 direct outlet page fetches plus browser/search-tool lookups; no paid scraper or LLM scoring calls. No cron or workflow changes.
