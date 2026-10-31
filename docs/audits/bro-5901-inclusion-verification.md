BRO-5901 verification, 2026-10-26

The survivor rollback fix is already present on main. The acceptance command,
`node --test scripts/tests/dedupe-survivor-exclusion.test.mjs`, passed 14/14
before any edit and again after the diagnostic-message change. No rebuild or
deduplication logic was changed in this verification.

The card identifies landed commit `0b3faf30f69b3eacb169309f6ce7cf0bb36faa90`.
Its public source archive contains the claim ledger and emitted-state shields;
the baseline archive at `75fa178ebc3dffa022accb38c3404495a50f7e04` lacks them.
Current main imports and calls these functions in `scripts/rebuild-all-reviews.js`:
claims begin per file, arm after deduplication, commit on emission, and roll back
in `finally` when a later gate drops the winner.

`git log -S 'createClaimLedger' --oneline -5 -- scripts/rebuild-all-reviews.js`
reaches shallow boundary `7bc7aaa4`, so local history alone cannot identify the
original landing. Fetching the historical commits failed because Git metadata
is read-only. Public source archives supplied both versions without changing Git
history or creating another checkout.

The remaining requested diagnostic hint was absent. `scripts/scoring-delta.js`
now prints this existing comparison command from `printCannotAutoVerifyBanner()`:

```sh
node scripts/cloud-run-script.js --review-texts --timeout=55 scripts/rebuild-inclusion-diff.js --base=<40-char sha> --head=<40-char sha>
```

Both existing warning callers use that function. Invoking the real function
before and after the edit with the real `skippedNoScore`,
`skippedFilmTvContamination`, and `skippedTourContamination` call sites changed
recipe visibility from false to true in all three cases. The edit changes no
review records and adds no script, flag, automatic execution, or cron.

For the outstanding real-data comparison, both historical `scripts/` trees were
extracted from their public GitHub source archives into disposable directories
inside this checkout. Each received an independent copy of the same complete
current `data/`, including review texts, and used the current `src/` and
`node_modules`. This matches the comparison tool's scripts-only scope while
keeping normalization writes away from the protected private clone. Full
rebuilds also verify the final aggregate deduplication passes. Both commands
exited 0:

```sh
node .bro5901-tmp/base/scripts/rebuild-all-reviews.js --ignore-pause --force-write
node .bro5901-tmp/head/scripts/rebuild-all-reviews.js --ignore-pause --force-write
```

Each scanned 2,818 show directories. Final output grew from **33,206 to 33,207
reviews**: one added record, zero removed records, zero modified existing records.
Records were matched by show, outlet, critic, and URL; all fields of shared
records were compared. No unrelated record changed.

| Real-data case | Before | After | Explanation |
| --- | ---: | ---: | --- |
| `angels-in-america-2018` | 54 | 55 | Tulis McCall's Front Row Center review is recovered. The NYTG primary has no score and is excluded, so it must not shield the scored secondary. |
| `groan-ups-west-end-2019` | 9 | 9 | The unscored Matt Wolf copy releases its dedup claim. The unknown-byline copy reaches the no-score gate and is also excluded. No unscored review is emitted. |
| `paranormal-activity-2026` | 39 | 39 | Both Chris Jones source files remain. Both now carry score 86, so exactly one Tribune review is emitted in each run. Current data also has that one Tribune record. |

These are **all** per-file exclusion-reason changes in the completed runs:

| Show / file | Before | After | Effect |
| --- | --- | --- | --- |
| `angels-in-america-2018/front-row-center--tulis-mccall.json` | `skippedSyndicated` | No exclusion | One legitimate fallback recovered. Its NYTG primary remains `skippedNoScore`. |
| `groan-ups-west-end-2019/i-paper--unknown.json` | `skippedUnknownCriticDedup` | `skippedNoScore` | Claim release allows reevaluation; still excluded for no score. |

There were no new circular-duplicate tiebreak transitions. The current supplied
`reviews.json` already contains the recovered Front Row Center record, so no
private-data fix plan or backfill is needed. The acceptance fixtures cover the
historical unscored-Tribune condition, which is absent from today's real case.

Other verification:

- `node scripts/scoring-delta.js`: exit 0, no inclusion, score-value, or review-text
  flag changes versus HEAD; nothing to check.
- `node scripts/test-temporal-override-regression.js`: exit 0, OVERALL PASS,
  both suites green.
- `node --test --test-timeout 300000 $(rg -l 'scoring-delta' tests scripts --glob '*.test.*')`:
  463 passed, one pre-existing failure. The failing
  `scripts/lib/international-trade-cross-market.test.mjs` fixture tries to create
  `data/review-texts/__test-bro2749-west-end-*-2026` in the protected clone and
  fails with `ENOENT`. Running that file with the original `origin/main` copy
  of `scoring-delta.js` reproduced the same failure: six passed, one failed.
- `node --test --test-timeout 300000 scripts/tests/dedupe-survivor-exclusion.test.mjs`:
  14 passed, zero failed or skipped after the edit.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  audit log reported all gates green, but the temporary output directory
  disappeared before metadata was recorded. Repeated with output directory
  `.bro5901-tmp/gauntlet`: `lint-workflows.exit` was 0 and the log reported
  all gates green. Missing actionlint was the permitted environment warning.
- `git diff --check`: passed. No TypeScript files changed.

New paid fetches, LLM calls, and API calls per run: **zero**. Verification used
public source-archive downloads; neither the fix nor the rebuild adds network
work. No workflow or cron changed. Disposable source/data copies and logs were
removed after verification. No private data or review text is included here.
