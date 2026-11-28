# BRO-4998 verification, 2026-10-30

Partial resolution. The worker leaves a pending private-data plan and tested
code in the checkout. The card must not close merely because its regression
test now exists. Collection and live Off-Broadway press-night verification
remain outstanding.

## Changes and evidence

- `scripts/lib/review-write-guard.js`: protect and honor intentional retraction
  of `wrongProductionClearedNote`. The real plan initially passed 8/10 actions:
  both Fences flags failed with `write guard reverted wrongProductionClearedNote`.
  The existing retractor deleted the field, but merge mode restored it. The
  corrected writer passes all 10 actions. A disk-write regression also fails
  with the unchanged `origin/main` writer and passes with this change.
- `scripts/lib/press-night-cross-check.js` and the two existing date enrichers:
  compare machine Playbill/review-derived openings with original independent
  Theatremonkey/Lortel evidence. Successful checks take precedence over merged
  opening dates; suspicious bounds veto opening writes. Unavailable evidence
  is advisory and preserves existing preview enrichment. Human corrections and
  Broadway dates stay outside this new rule.
- The West End writer now preserves which source supplied the opening. A
  Theatremonkey preview plus a Playbill opening must not be stamped as a
  Theatremonkey opening. This would otherwise bypass subsequent cross-checks.
- `tests/unit/newsletter-2026-10-05-audit.test.mjs`: the previously missing
  acceptance command now has 12 tests importing production helpers. Covers
  temporal guards, transfer policy, gap filtering, independent confirmation,
  unavailable/conflicting evidence, preview composition, source provenance,
  and persistence through the real review writer.
- `data/pending-fixes/bro-4998.json`: 10 field actions on 8 records. Sources are
  recorded in each action. `.gitignore` exposes this specific public-safe plan
  to the runner without staging private data.

## Checklist a-e

**a. Real data before/after.** Replayed the plan through `executeReviewFieldEditIn`
on temporary copies and `applyDataEdit` on an in-memory shows copy. Eight target
records change; no private source files were written. Both Oxford Fences rows
change from effectively included to effectively wrong-production. Jackstage's
verified 3/5 changes `getBestScore()` from 78 to 60. Jupiter's unsupported 5/5
is removed while its existing human-reviewed score stays 86. Ghost's opening
changes October 9 to October 14. The plan also deduplicates Rent and corrects
two critic fields.

The date helper was run across all 5,349 real show records without inventing
independent evidence: 401 machine-sourced dates need a cross-check, 279 of
which the old unconfirmed-source predicate did not select. All 401 return
unverified when evidence is absent, with zero proposed date changes; the
other 4,948 records are unchanged. Examples: Fences and From the Heart remain
unverified, while Rent's existing Theatremonkey date is untouched. Successful
independent-source corrections have unit coverage, not a live scraper run.

**b. Real writer/caller.** `retractScriptWrongProductionClear()` feeds
`safeWriteReview()` through `executeReviewFieldEditIn()`; the fix is in the
writer's protected-field/intentional-clear contract. The date check is in
`enrich-west-end-dates.js` and `enrich-off-broadway-dates.js` before their
existing save path, not a display reader.

**c. Main check.** `git ls-tree origin/main
tests/unit/newsletter-2026-10-05-audit.test.mjs` returned no entry. The original
acceptance command printed `Could not find ...`. Requested `git log -S` checks
were attempted for `pressNight`, `review-derived-press-night`,
`priorRunUrlSignal`, and `pressNightEvidence`; historical traversal could not
complete because missing promisor objects require writes to the read-only
shared Git object store. No claim of a complete historical search is made.
Current main's already-landed gap filters were rechecked against the real gap
audit: 19 shows, 113 citations, 87 prior-run exclusions, zero remaining
current-run URLs classified as non-review/listing candidates. No gap-filter
change was needed.

**d. Wired in.** Both enrichers require and call `crossCheckOpeningDate()` and
`mergePressNightChanges()`. The West End writer calls `westEndOpeningSource()`.
Their existing scheduled workflows invoke those scripts; no workflow changed.
The pending plan uses the existing approved-fix executor. The new test is
automatically discovered under `tests/unit`; no manifest change.

**e. Cost.** Zero new paid fetches, SERP queries, LLM calls or API calls per
scheduled run. Candidate selection and existing fetch calls are unchanged.
The checks reuse already-fetched listings. The separate web lookups for this
audit do not add a cron or production dependency.

## Per-show disposition

| Finding | Recheck / action |
| --- | --- |
| Into the Woods / Kramer-Fauci carryover | Existing `inheritReviews:false` remains in place. No policy change. |
| Fences | Plan flags the two Oxford rows; Northern Arts Review is already flagged. Susan Elkin's Reviews Hub review is present. |
| An Oak Tree | Time Out's republished review is already `wrongProduction:true`. |
| Affluenza | Original Time Out row now says October 9. Monstagigz is dated September 29, after the stored September 26 preview start. A preview review is not automatically a prior-production review; left intact. |
| Slam Frank | The live Theater Life quote now belongs to Slam Frank. The excluded duplicate blog row still has the old unrelated quote; private-text cleanup remains. |
| Franz & Marie | Plan clears Jupiter's unsupported stars and sets Jackstage's 3/5. North West End already has 5/5 and score 96; WhatsOnStage and Everything Theatre are present. First Night's tag-page stub needs recovery; Curtain Call is absent. |
| Rent | Plan marks the URL-less row duplicate and corrects the surviving row's critic to A. Tran Ngoc. FT is already present in rebuilt reviews with a score. |
| The Hairy Ape | Plan corrects Theatrely to Juan A. Ramirez. America Magazine and Hangover Report remain absent. |
| Good Time Charlie | All four named outlets are present, including 1 Minute Critic and Kearley. |
| Kramer-Fauci / Slam Frank | Kearley/BroadGAYS remain absent. Kramer-Fauci's New Yorker row still lacks a URL. The NYT Helen Shaw byline is corroborated by indexed article records; direct NYT access was blocked, so no speculative byline edit. |
| Blood of My Blood / The Hungry Ghost | Blood's cast is already corrected. Brit Brief and Khambay remain absent for Blood, and Khambay for Hungry Ghost. |
| Ghost / From the Heart | Plan changes Ghost's opening to October 14; its preview is already October 3. From the Heart is already October 8. |
| Triumph / Betty / Fish / Virtuous Burglar | Current rebuilt review counts are respectively 5, 0, 10, 2. Triumph's five reviews are dated October 11 or later, after the original audit. No data change. |

Primary-page checks: [Ghost dates](https://www.tdf.org/shows/23452/a-ghost-in-your-ear/),
[From the Heart press night](https://www.whatsonstage.com/news/don-blacks-from-the-heart-revue-adds-further-names_1731449/),
[Theatrely byline](https://www.theatrely.com/post/excellent-stagings-of-our-basest-selves-degenerates-the-hairy-ape-review-roundup),
[Jackstage rating](https://www.jackstage.co.uk/post/franz-marie-review-imaginatively-staged-musical-after-b%C3%BCchner-s-woyzeck),
[Jupiter page](https://jupiterhadley.com/franz-and-marie-at-charing-cross-theatre/),
[Rent byline](https://www.thereviewshub.com/rent-tom-stoppard-theatre-london/),
[Fences Oxford AYP](https://ayoungishperspective.co.uk/2026/10/03/review-fences/),
[Fences Oxford BTG](https://www.britishtheatreguide.info/reviews/fences-oxford-playhous-26068).
The [indexed NYT article attribution](https://muckrack.com/helen-shaw/articles)
supports leaving Helen Shaw's NYT row unchanged; it is not a fresh full-page check.

## Verification commands and results

- `node --test tests/unit/newsletter-2026-10-05-audit.test.mjs`: initially
  FAIL (missing file); final PASS, 12/12.
- `node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-4998.json`:
  initially 8/10; final PASS, 10/10 applied cleanly on disposable copies.
- `node --test --test-timeout 300000` with the 15 files found by
  `rg -l 'enrich-west-end-dates|enrich-off-broadway-dates|press-night-cross-check' tests scripts --glob '*test.*'`:
  PASS, 265/265.
- Same Node command with the 114 files found by
  `rg -l 'review-write-guard|review-field-edit' tests scripts --glob '*test.*'`:
  2,107 pass, 2 fail. Both failures also reproduce with `origin/main`'s
  unmodified writer loaded via a temporary Node preload: the existing corpus
  attribution audit and `url-change-invariant.test.mjs` attempting to create
  a fixture under the read-only private review-texts link (`ENOENT`).
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  all available checks pass; exit 1 solely because `actionlint` is missing
  (exit 127). Read `lint-workflows.log`; no workflow files changed.
- `git diff --check`: PASS. No TypeScript or UI files changed.
- `node scripts/scoring-delta.js --base=origin/main`: PASS, exit 0;
  69,991 reviews processed, zero newly included, zero newly excluded, zero
  T1 flips. The script noted that the private critic-registry baseline was
  unavailable and replayed inclusion using the available corpus; no registry
  data was changed by this worker.
- `node scripts/test-temporal-override-regression.js`: PASS, exit 0;
  both temporal regression suites green.

Independent code review found and then cleared the preview/provenance issues.
The external API reviewer could not run because its API key is unavailable.
No deployment or CI job was started. Linear access is unavailable
(`LINEAR_API_KEY not set in .env or environment`).

Review coverage: phase 2 ran the targeted tests and available workflow audits;
phase 3 replayed the private-data plan on temporary copies; phase 4 skipped
visual QA because there is no UI change; phase 5 ran an independent code
review, but external API review was unavailable. This is not a completed
external ship-check.

Adjacent-work lenses: pattern search found the `bww-roundup`/`wet-roundup`
writers and included those source labels; boundary tests cover missing sources
and invalid dates; user-impact replay preserves Jupiter's existing score;
data checks found the stale clear-note writer defect and fixed it; reuse stays
in the shared helper rather than adding a new cron. The Linear keyword search
failed with the missing-key error above. No new board item was created.

## Remaining

- Runner must apply the pending plan and rebuild private derived data.
- Replace or restore the unavailable Lortel feed to complete live automatic
  Off-Broadway press-night corroboration. The existing scraper documents its
  removed listing; this change makes that absence visible, not confirmed.
- Collect the absent outlets listed above and recover the First Night stub
  and Kramer-Fauci New Yorker URL through the existing collection pipeline.
- Clean the excluded Slam Frank blog's wrong quote in the private repository.
  A public field-edit plan cannot contain its old/new review text.
- The requested Linear split remains for a Linear-capable runner/session.
