# BRO-7702 recheck, 2026-11-23

Status: partial; the coverage target is not met. No private review data was changed.

VERIFY: `node scripts/check-outlet-fulltext-floors.js`

The card's `node scripts/lib/verify-data-backfill.js --show=wsj,times-uk,standard,washpost`
fails with four `show missing` results. That verifier accepts show IDs, not outlet IDs.
Do not broaden it to reinterpret these names or declare the card complete.
Replace the card's acceptance command with the VERIFY above.

## Fix and effect

`evaluateFloors()` in `scripts/lib/outlet-fulltext.js` produced a passing outlet verdict
below 98% if all gaps had recovery attempts. That exception belongs only to the other
outlets' 95% target. The four strict outlets now fail below 98% regardless of attempts.
The CLI's explanation now describes that policy. Percentages, denominators, review
classification, queue order, and paid-fetch budgets are unchanged.

The same real corpus and ledger were passed to
`node scripts/check-outlet-fulltext-floors.js --json` before and after:

| Outlet | Held-review coverage | Guard coverage including pending | Before fail | After fail |
| --- | ---: | ---: | --- | --- |
| WSJ | 98.37% | 97.6% | false | true |
| Times UK | 92.83% | 91.8% | true | true |
| Standard | 98.50% | 98.0% | false | false |
| WaPo | 93.75% | 93.8% | false | true |
| Variety | 94.59% | 94.6% | false | false |

Exactly two of 14 outlet verdicts change. Zero percentages and zero private records
change. WSJ and WaPo are the intended corrections; Variety is the control for the
permitted attempted-gap exception. The corrected guard fails on five outlets and
seven stale unattempted gaps. It must remain advisory in scheduled monitoring.

## Card items checked

1. Metric: complete-tier short reviews, quoted excerpts, and scanner exclusions are
   already implemented. `node scripts/report-outlet-fulltext-gaps.js --json` reports
   74 held-review gaps. Do not hide them to satisfy the target.
2. Dedupe: `data/pending-fixes/bro-7702.json` is applied. Reading all 14 actions and
   their real target records confirms 14/14 expected `duplicateOf` values.
3. Re-URL: the wrong pages have not all been replaced. The current dry run already
   routes Invisible Me at position 9 and The Price at position 17 to URL_FIND.
   Setting `incompleteReason=wrong_content` alone is not a durable routing fix:
   `text-gap-classify.js` calls `classifyIncompleteReason()`, which derives that
   reason from exclusion flags. Do not set exclusion flags merely to improve coverage.
   The historical URL-replacement writer is `maybeUpgradeUrl()` in
   `scripts/lib/review-normalization.js`. Correct replacement URLs need page evidence.
   The Music Man row still names outlet `standard` while its recorded critic is
   Standard Topic; registering the outlet and moving its file remain outside the
   permitted field-edit plan actions for this worker.
4. Queue: `node scripts/gap-recovery-driver.js --dry-run --recent-only` exits 0.
   There are 1,077 recent gaps, 801 routable candidates, and 77 planned items.
   All 21 planned major-outlet items occupy positions 1-21. Times unattempted rows
   occupy 2-8. The default URL_FIND capacity is 12 paid-capable plus 24 free slots,
   so total capacity is already above 12 without increasing paid spend.
5. Standard mismatch inspection: all three rows now hold complete text:
   4.48 Psychosis 3,933 characters, Clueless 4,462, Deaf Republic 4,569.
   Source pages identify the expected productions and Nick Curtis:
   [4.48 Psychosis](https://www.standard.co.uk/culture/theatre/4-48-psychosis-royal-court-theatre-review-b1233744.html),
   [Clueless](https://www.standard.co.uk/culture/theatre/clueless-the-musical-trafalgar-theatre-review-b1216691.html),
   [Deaf Republic](https://www.standard.co.uk/culture/theatre/deaf-republic-royal-court-jerwood-theatre-b1246686.html).
   Their old mismatch details say zero mentions. The current validator counts
   2/1/4 in stored text. Body-only replay rejects the first two; replay using the
   observed source headline in a title element passes all three. The collector
   already passes `titleHtmlFor(result)` to `validateContentMentionsShow()`.
   Original archived HTML is unavailable here, so this is a headline replay, not
   a reproduction of the original fetch. No gate weakening is justified.
6. Nightly stability: the last three rows in `data/audit/gap-recovery-nightly.jsonl`
   (November 21-23) all have `status: ran`, `pushFailed: false`, and recovered
   13/57/54 reviews. The retry-pending code is already present.
7. Floor guard: fixed the strict-outlet exception. Existing callers are
   `scripts/gap-recovery-nightly.js:82` and the advisory audit registration in
   `scripts/check-corpus-drift.js`. The nightly summary reaches the digest via
   `outletFloorSummary()` and `outletFloorLine()`. No workflow was edited.

## Verification and RULE21

- `node --test --test-timeout 300000 scripts/lib/outlet-fulltext.test.mjs`:
  before the implementation fix, 11 pass and 3 fail; after, 14 pass and 0 fail.
  Replacing the helper with `git show origin/main:scripts/lib/outlet-fulltext.js`
  repeats the same three failures (exit 1); restoring the fix passes (exit 0).
  The tests require the real helper and cover all four strict outlets, the ordinary
  outlet exception, attempted pending rows, the exact threshold, and rounding.
- `node --test --test-timeout 300000 scripts/lib/outlet-fulltext.test.mjs scripts/lib/gap-routes.test.mjs scripts/lib/gap-recovery-ledger.test.mjs scripts/lib/gap-recovery-nightly.test.mjs`:
  82 pass, 0 fail.
- `grep -rl 'outlet-fulltext' tests scripts --include='*.test.*'` identifies the
  outlet, routes, and ledger tests run above; nightly tests cover the summary consumer.
- `grep -rnlE 'below && unattempted|below floor.*(all|every)|every outlet is at its floor|below floor with unattempted' src/ scripts/ data/ tests/ .github/`:
  the decision was centralized in `evaluateFloors`; the CLI wording and two old
  test expectations were its live cousins and are corrected. Historical audit
  output is evidence, not a writer, and was left unchanged.
- `git log -S 'STRICT_OUTLETS' --oneline -5 -- scripts/lib/outlet-fulltext.js`:
  history traversal could not fetch a missing promisor object because the Git
  object store is read-only. `git rev-parse HEAD origin/main` confirms both were
  `968db7520e982f5c8412687b07cb5f55ce51999e`. `git show origin/main:scripts/lib/outlet-fulltext.js`
  confirms main still uses `fail: below && unattempted > 0`.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  exit 1 only because `actionlint: command not found` (exit 127). All other
  blocking audits passed, including top-level script coverage and lib dependencies.
  The permitted missing-tool exception applies; the full log was inspected.
- `git diff --check`: passes. Final status contains only the helper, its test,
  the CLI, this report, and the `.gitignore` exception that retains this report.
- No TypeScript, UI, scoring logic, content-quality regex, or workflow edits.
- Cost: zero added paid fetches, LLM calls, or API calls per run. The existing
  scheduled guard still reads local files. Investigation used three web page reads.

## Review limits and follow-through

TESTED: real review-texts plus the real attempts ledger; strict attempted gaps,
the ordinary outlet exception, and an outlet at its target all checked before/after.
No unintended percentage changes. Nothing deployed.

COVERAGE: targeted tests and corpus audit ran; no UI or build effect. Independent
external review could not run: neither OPENAI_API_KEY nor GEMINI_API_KEY is present.
NO-SHIP-CHECK: full independent review is deferred to the runner; no review pass claimed.

LENSES:
1. Pattern: repository-wide grep found the shared verdict and its CLI/test cousins; fixed.
2. Edges: regression checks 97.99%, exactly 98%, pending attempts, and default floors; pass.
3. User impact: before/after corpus JSON shows two misleading passes corrected; no coverage inflation.
4. Data/infra: three nightly ledger rows show successful runs; recovery and private-data work remain.
5. Compounding: the existing nightly and digest consume the same helper; no duplicate verifier added.

The board search and session claim both failed because LINEAR_API_KEY is unavailable.
Git metadata is read-only, so this run cannot commit or land. Changes remain in the
working tree for the runner. All launched test processes finished; temporary test
directories were removed.

CLASS-GUARD: scripts/lib/outlet-fulltext.test.mjs

REMAINING: Replace the Linear acceptance command with the VERIFY above; this worker cannot update the board.
REMAINING: Recover text to meet the strict floors, process pending candidates, and log genuine recovery attempts for the seven stale unattempted gaps. A dry run is not an attempt.
REMAINING: Finish evidence-backed URL corrections and the Standard Topic outlet registration/file move. Several original non-review rows are already excluded; do not reopen them blindly.
REMAINING: Owner subscriber logins for WaPo/Times and the WSJ browser recovery require a browser-capable worker. This environment reports platform_linux and has no subscriber browser.
REMAINING: A dedicated test.yml step was requested historically; the existing corpus-drift check is advisory, and workflow edits are excluded from this task.
