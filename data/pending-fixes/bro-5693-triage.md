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

The writer is `scripts/audit-slug-mismatch-lifetime.js`, delegating to
`scripts/lib/opening-night-checks/lifetime-sweep-runner.js`. It invokes the
real `slug-mismatch.check.js` against shipped reviews and saved source text.
`scripts/health-check.js` reads that writer's snapshot and warns on new keys.
Neither the health rule nor the baseline needs changing.

`git log -S '5+ digit' --oneline -5 -- scripts/lib/opening-night-checks/slug-mismatch.check.js`
finds `f7864ec6` in this checkout's history. The Stage numeric-ID exemption
already exists on main, and `bro-5693.json` records the applied No I.D. stub
deletion. Neither fix is repeated here.

## The real data repair

File: `stranger-things-the-first-shadow-west-end-2023/express-uk--neil-norman.json`.
Both local source trees still store `https://www.express.co.uk/latest/theatre`,
a section index, as this review's URL. The source is a Theatre Record print
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

The final diff contains only this triage, the pending URL repair plan and
their exact `.gitignore` exceptions. Matcher experiments were removed after
the seven missing source files were located and verified. No audit or
health snapshot was rewritten.
