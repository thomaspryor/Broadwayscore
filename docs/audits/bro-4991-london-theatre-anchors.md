# BRO-4991: London Theatre anchor verification

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
