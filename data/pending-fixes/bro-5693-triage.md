# BRO-5693 follow-up triage

The card remains open until the private repair is applied and the scheduled
health snapshot passes its acceptance command. Do not clear or rebaseline the
health warning to make the check pass.

## Reproduction and source

`node scripts/check-health-row-absent.js --row-b64 RGF0YSBxdWFsaXR5OiBzbHVnLW1pc21hdGNoIGxpZmV0aW1lIHN3ZWVw`
fails: the row is still in the 2026-10-20T12:08:24.981Z health snapshot.

`node scripts/audit-slug-mismatch-lifetime.js --json --no-snapshot`
finds 184 mismatches against the runner-supplied corpus. Comparing
`hits[].showId + '::' + violations[].url` with the original
`data/audit/slug-mismatch-lifetime.json` gives eight new keys. That saved
baseline has 177 keys, including the subsequently deleted No I.D. stub.
The JSON's `newSinceLastRun` is the total when `--no-snapshot` is used, so
the eight-key delta was computed explicitly, without rewriting the baseline.

The snapshot producer is `scripts/audit-slug-mismatch-lifetime.js`, delegating to
`scripts/lib/opening-night-checks/lifetime-sweep-runner.js`. It invokes the
real `slug-mismatch.check.js` against shipped reviews and saved source text.
`scripts/health-check.js` reads that writer's snapshot and warns on new keys.
Neither the health rule nor the baseline needs changing.

`git log -S '5+ digit' --oneline -5 -- scripts/lib/opening-night-checks/slug-mismatch.check.js`
reaches only the shallow history boundary in this checkout. The Stage numeric-ID
exemption is already present in `origin/main` at `slug-mismatch.check.js:196-200`, and `bro-5693.json` records the applied No I.D. stub
deletion. Neither fix is repeated here.

## The real data repair

File: `stranger-things-the-first-shadow-west-end-2023/express-uk--neil-norman.json`.
`bro-5373-s.json:122-127` already cleared
`https://www.express.co.uk/latest/theatre` to `""`. Its successful results
entry at line 225 and `executedAt: 2026-10-15T01:12:09.284Z` prove the clear
was applied. The Express file retains that approved-fix stamp, yet both
local corpora and shipped reviews hold the section URL again. Something
restored it after October 15. The Mail on Sunday sibling cleared in the
same plan still has an empty URL. The source is a Theatre Record print
review, and its saved text concerns the correct production. Excluding it as
`wrongShow` or deleting it would remove a legitimate review.

The Daily Express entry on
[West End Theatre's review roundup](https://www.westendtheatre.com/211940/news/reviews/stranger-things-the-first-shadow-reviews/)
identifies Neil Norman and links directly to
`https://www.express.co.uk/entertainment/theatre/1845793/stephen-daldry-stranger-things-theatrical-prequel-dazzling-show`.
Its excerpt agrees with the saved print review. This is the source for the
replacement URL, not a guessed URL derived from a title or date. The outlet
page itself was inaccessible to the web tool; its live response remains to
be verified after the repair.

`bro-5693-b.json` contains the compare-and-set URL repair. The existing
executor loads it with `issue_number=bro-5693-b` and the JSON's `planId`.
Preflight against both the supplied corpus and the other local checkout
reports `1/1 applied cleanly`. It exercises `executeReviewFieldEditIn`,
including the write guard and URL-change invariant. A URL repair clears old
URL-derived text, scores and publish date, and requests refetch. Apply the
plan, collect and verify the corrected review, then rebuild shipped reviews.
The private files were never written by this worker.

## Seven missing files, now triaged

All seven are absent from `data/review-texts` in this worktree. All seven
exist in the separate `/home/user/broadway-review-texts` checkout, which was
read only. Each file holds the exact shipped URL, has complete source text,
and passes main's existing check when that directory is provided. Each
saved text names its show in the first 1,500 characters. No matcher changes
or review exclusions are warranted. The filenames below were read from
disk, not inferred from critic names.

| Show ID | Private filename | Triage |
| --- | --- | --- |
| spare-parts-off-broadway-2026 | the-interested-bystander--interested-bystander.json | Correct show-specific text from a multi-show article. Refresh the supplied corpus. |
| rheology-off-broadway-2026 | talkinbroadway--marc-miller.json | Correct review; existing text confirmation passes. Refresh the supplied corpus. |
| well-ill-let-you-go-off-broadway-2026 | talkinbroadway--james-wilson.json | Correct review; existing text confirmation passes. Refresh the supplied corpus. |
| lets-love-off-broadway-2026 | talkinbroadway--kimberly-ramirez.json | Correct review; existing text confirmation passes. Refresh the supplied corpus. |
| king-of-the-yees-off-broadway-2026 | talkinbroadway--james-wilson.json | Correct review; existing text confirmation passes. Refresh the supplied corpus. |
| oratorio-for-living-things-off-broadway-2026 | talkinbroadway--james-wilson.json | Correct review; existing text confirmation passes. Refresh the supplied corpus. |
| kyoto-off-broadway-2025 | talkinbroadway--howard-miller.json | Correct review; existing text confirmation passes. Refresh the supplied corpus. |

The Interested Bystander
[source article](https://www.interestedbystander.com/2026/03/theater-reviews-mint-theater-presents.html)
also confirms that Spare Parts has its own review section. A broad URL
exemption would hide real contamination and is unnecessary.

## Validation and limits

The two complete-corpus runs use main's unchanged matcher:

```sh
node scripts/audit-slug-mismatch-lifetime.js --json --no-snapshot --review-texts-dir=/home/user/broadway-review-texts
node scripts/audit-slug-mismatch-lifetime.js --json --no-snapshot --review-texts-dir=/home/user/broadway-review-texts --reviews-path=/tmp/bro-5693-proposed-reviews.json
```

The temporary proposed reviews document copies real `reviews.json` and
changes only the one Express URL, exactly as specified by the preflighted
plan. This models the shipped URL after applying the private repair and
rebuilding; it does not claim either has happened yet. Both outputs are
compared with the same untouched 177-key baseline. The complete-corpus run finds 177 violations, with only the Express category
URL new against the saved baseline. The proposed run finds 176 violations
and zero new keys. The remaining 176 keys
are all already in that baseline. Temporary files are deleted after checks.
Both audit commands exit 1 because historical violations remain; the
acceptance evidence for this repair is the explicitly compared new-key delta,
not an all-clear audit exit code.

No network calls are added to the daily sweep or health check. Applying the
one-record URL plan schedules one existing collector recovery, which may
use the existing paid scraper/LLM fallback and retries. This is a one-time
repair, not a new recurring paid job. No paid collection or scoring was run
by this worker.

The worker cannot apply private-repository writes under this task's rules.
The saved health acceptance command therefore still fails. After applying
the plan, recovering the review and refreshing the corpus, run the sweep
once and verify zero new keys against the current baseline, then let the
scheduled health digest regenerate its snapshot and rerun the acceptance
command. A live pass against an old sweep snapshot is insufficient.

Checks run:

- `node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-5693-b.json`:
  PASS, `1/1 applied cleanly`. An additional invocation of the exported
  `preflight()` explicitly selecting this worktree's `data/review-texts`
  gives the same result.
- `node --test --test-timeout 300000 tests/unit/slug-mismatch-opaque-urls.test.mjs tests/unit/slug-mismatch-text-confirmed.test.mjs`:
  PASS, 22 tests on the unchanged main matcher.
- `node --test --test-timeout 300000 scripts/lib/review-field-edit.test.mjs scripts/lib/preflight-review-fix-plan.test.mjs`:
  PASS, 51 tests validating the existing plan executor and preflight.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  only failure was `actionlint: command not found` (exit 127), which the task
  explicitly permits ignoring. The log's final failure list contains only
  `actionlint`. Other workflow guards passed. No workflows were edited.
- The acceptance command at the top: FAIL before and after, against the
  unchanged saved health snapshot. Adding `--live` gives PASS, which is not
  evidence that the proposed private repair has been applied.
- `git diff --check`: PASS. No TypeScript or scoring code was changed.

## Independent-review fix round

### Writer trace and history limit

Commands actually run:

```sh
git -C data/review-texts log -p --since=2026-10-15 -- stranger-things-the-first-shadow-west-end-2023/express-uk--neil-norman.json
git -C /home/user/broadway-review-texts log -p --since=2026-10-15 -- stranger-things-the-first-shadow-west-end-2023/express-uk--neil-norman.json
git -C /home/user/broadway-review-texts rev-parse --is-shallow-repository
rg -n 'aligned to canonical slug|same express article ID|serp-recovery' scripts cloud-memory
git log -S 'serp-recovery' --oneline -5 -- scripts/recover-explicit-ratings.js
git log -S 'listing-page-url' --oneline -5 -- scripts/lib/review-file-writer.js
```

The supplied `data/review-texts` directory has no private `.git`; its log
resolves to the enclosing public checkout and returns no file history.
The separate private clone reports `true` for shallow history. Its only
available file commit is snapshot boundary `316b80f2e`, dated October 21,
which presents the entire file as added. This cannot identify the actual
post-clear restoring commit. No fetch or private-repository write was made.

`urlSource: serp-recovery` traces to `recover-explicit-ratings.js:327-329`:
phase 0 assigns the discovered URL and persists through
`persistReviewSnapshot()`, bypassing `createOrMergeReviewFile()`. The
snapshot helper previously accepted any caller URL edit over disk, even
when disk carried an approved URL fix. The shared writer independently
allowed listing URLs on existing files because its listing guard only
covered creates. Both are now guarded at the actual write/merge paths.
This proves vulnerable callers, not which one restored this particular file.

The exact `aligned to canonical slug` reason has no writer in the checked-out
scripts or cloud memory. The file's associated `urlUpdatedAt` and
`_urlChangedClear.at` are July 26, before the October 15 approved clear.
That old breadcrumb does not prove the October refill used canonicalization.
The exact historical caller remains unverified because the necessary private
history is unavailable here.

### Prevention and blast radius

- `scripts/lib/approved-url-fix.js`: one shared predicate rejects a
  pattern-matched listing URL that contradicts the most recent approved URL
  fix. Genuine article URLs, non-URL approvals, and an explicitly approved
  listing URL remain allowed.
- `scripts/lib/persist-review-snapshot.js`: consults current disk approvals
  after the three-way merge. Refuses the whole candidate snapshot on a bad
  URL refill, preserving the approved URL and preventing candidate body/score
  contamination. Rebases caller memory onto disk for later recovery phases.
- `scripts/lib/review-file-writer.js`: applies the same predicate before
  either existing-file merge route mutates the record. Retains the existing
  explicit `allowNonReviewUrl` override.
- `scripts/lib/non-review-url-patterns.js`: recognizes the missing Express
  `/latest/theatre` section index, with the same anchored host/path scope as
  `/entertainment/theatre`. Article permalinks remain allowed.
- Regression tests require the real writer functions in the three adjacent
  `*.test.mjs` files. They cover empty/permalink repairs, concurrent approvals,
  approved listing exceptions, valid recovery and non-URL approvals.

Before changing production code, the two writer test files reported
14 passed and 6 failed. The pattern test reported 45 passed and 1 failed.
After the fix the three touched test files report 67 passed, 0 failed.

A temporary probe called the real `persistReviewSnapshot()` and
`createOrMergeReviewFile()` on copies of three actual review records,
replaying the recorded approved clear before the next write. It also
classified all 58,088 supplied review files before and after. Exactly one
classification changes: the Stranger Things Express file, from unrecognized
to `section-index-page`. Of 99 records with URL approvals, only that one
currently carries a listing URL that contradicts its approved value.
The Band's Visit Talkin' Broadway index matches its explicit approved URL
and is preserved.

| Real input | Before | After |
| --- | --- | --- |
| Stranger Things / Express / Neil Norman | Recovery restores `/latest/theatre`; shared merge permits it | Recovery keeps the approved empty URL; shared writer refuses the listing |
| Stranger Things / Mail on Sunday / Robert Gore-Langton | Empty approved URL preserved | Same |
| Stranger Things / Guardian / Arifa Akbar | Genuine article permalink preserved | Same |

The probe and corpus copies were temporary and removed. Source review files
were read only. The unchanged complete-corpus sweep confirms the modeled
one-record repair still changes 177 violations / 1 new key into
176 violations / 0 new keys. Historical keys were not rebaselined.

### Wiring, cost and validation

`rg -n 'approvedUrlFixListingReason' scripts/lib/{persist-review-snapshot,review-file-writer}.js`
shows both existing writers call the new helper. The recovery caller is
`recover-explicit-ratings.js:329`; ingestion calls the shared writer at
`ingest-urls.js:255`. No new script, flag or workflow was added.

New paid fetches, LLM calls and API calls per run: **0**. The guarded existing
recovery runs on the weekly recovery cron and the daily review-refresh cron;
the guard adds only local checks. No live collection or scoring was run.

Additional exact validation commands:

```sh
node --test --test-timeout 300000 scripts/lib/review-file-writer-listing-page.test.mjs scripts/lib/persist-review-snapshot.test.mjs scripts/lib/non-review-url-patterns.test.mjs
node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-5693-b.json
node --test --test-timeout 300000 scripts/lib/review-field-edit.test.mjs scripts/lib/preflight-review-fix-plan.test.mjs tests/unit/slug-mismatch-opaque-urls.test.mjs tests/unit/slug-mismatch-text-confirmed.test.mjs
rg -l 'review-file-writer|persist-review-snapshot|non-review-url-patterns|approved-url-fix' tests scripts --glob '*.test.*' > .tmp-bro-5693/related-tests.txt
node --test --test-timeout 300000 $(cat .tmp-bro-5693/related-tests.txt)
REVIEW_TEXTS_DIR="$PWD/.tmp-bro-5693/gather-corpus" node --test --test-timeout 300000 scripts/gather-reviews-named-non-review.test.mjs
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
git diff --check
```

Preflight: PASS, `1/1 applied cleanly`. Executor/matcher checks: PASS,
73 tests. Related tests across 88 files: 1,228 passed, 2 failed, 1 skipped.
Both failures are in the unchanged `gather-reviews-named-non-review.test.mjs`:
`ENOENT: no such file or directory, mkdir '.../data/review-texts/zzz-scratch-bro-4101-named-non-review-test'`.
That test defaults to writing through the supplied private-data symlink.
Rerunning it with the supported local `REVIEW_TEXTS_DIR` override passes
2/2. `git diff --quiet origin/main -- scripts/gather-reviews.js scripts/gather-reviews-named-non-review.test.mjs`
also confirms both failing source files are unchanged from main.

The saved-snapshot acceptance command still FAILS with the October 20 row.
Loading `origin/main:scripts/check-health-row-absent.js` with Node's real
module loader and invoking its exported `main(process.argv)` against the
same supplied snapshot also FAILS identically. No health/sweep baseline was
rewritten. No TypeScript, scoring-watchlist or content-quality regex file
was edited, so their additional commands do not apply.

Workflow gauntlet: its final failure list contains only `actionlint`,
with `actionlint: command not found` (exit 127), the permitted missing tool.
All remaining workflow gates pass. `git diff --check`: PASS.

The origin/main acceptance replay was `node .tmp-bro-5693/main-check.cjs`.
That temporary runner loaded the main script with `git show`, compiled it
with `Module._compile()` at the real script filename, and called its exported
`main(process.argv)` with the exact card arguments. It returned 1 with the
same October 20 row. The real-data probe commands were:

```sh
node .tmp-bro-5693/probe.cjs .tmp-bro-5693/classifications-before.json
node .tmp-bro-5693/probe.cjs .tmp-bro-5693/classifications-after.json
```

The working-tree fix round changes this triage, four library files
(including the new shared predicate), and their three adjacent test files.
The previously committed pending plan remains pending and unchanged.
