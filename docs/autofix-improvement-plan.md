# Digest-autofix: why it underperformed, what is already fixed, what is left (BRO-220)

Written 2026-10-04. The issue text quotes 2026-08-10 numbers (day 12 of repeated errors, 1/3 passes, 3/15 dispatches passed). Much of the cause has since been found and fixed. This plan separates what is closed from what remains, using the live ledger (`data/audit/digest-autofix-ledger.jsonl` on the Mac checkout) and the job logs.

## Current numbers (live ledger, 2026-10-04)

- 8 digest dispatches since 2026-08-14: 3 on 8/14, 3 on 9/14, 2 on 9/19.
- Outcomes: 4 pass, 4 fail. The 4 fails are 3 "spawn never observed" (the 8/14 batch, never started) and 1 `job-stopped-short` (BRO-3794, 2026-10-02).
- Cost per job: passes cost $11.75, $21.75, $11.90 and $22.14. The one stopped-short job cost $5.57.
- Since 9/14 every dispatched job actually ran: 4 of 5 passed and 1 stopped short. The "never started" failure class is not present in the post-9/14 batches.

## Root causes found, in order of impact

1. **Dry-run lockout (closed, BRO-3393).** `send-morning-digest.js` forced dry-run whenever any launchd job's `sync-refused-*.json` existed, so no cards were filed and nothing dispatched for about 29 days (6 dispatch rows in 31 days, on 2 days). Now only the digest's own sync tag counts (`autofixShouldDryRun`, with a regression test).
2. **Dispatches refused inside the child (closed, BRO-2499, BRO-3060).** The digest files `BSC Daily:` issues parked with a sentinel, and `linear-next.js` refused its own issues (autofix-filed guard, then parked guard). Fixed by `--allow-autofix-filed` and `--allow-automation-parked`, pinned by tests in `digest-autofix.test.mjs`. This explains the 8/14 "spawn never observed" batch.
3. **Empty-log timeouts and "in-progress forever" cards (closed, BRO-232, BRO-467).** Orphaned dispatches are judged after `ORPHAN_TIMEOUT_H = 3` and recorded as `card-fail`. A daily canary (`autofix-canary.js`) now proves the whole path end to end, and the "Autofix: jobs actually succeeding" health row reads outcomes, not attempts.
4. **Throughput caps (adjusted, BRO-3412, BRO-3438).** `DISPATCH_CAP = 3` per digest run, concurrency ceiling 3 (raised from 2 on 2026-09-15), spend breaker at $12 per 24h with zero completions. With jobs costing $12 to $22 each, a clean day is at most 3 jobs, which is intended.
5. **Fewer cards by design (BRO-4487, 2026-09-24).** A condition must persist 72h before it gets a card (`PERSIST_BEFORE_FILING_HOURS`). This is why 9/19 to 10/2 shows only 2 dispatches. It is not a defect, but it must be understood when reading the dispatch count.
6. **Scope too big for one session (open).** BRO-3794 ("Main: red streak") turned out to be three independent CI failures. The job hit the 120-minute hard budget, ended `job-stopped-short`, and the wrap-up gate rejected its block twice. A card that bundles several causes will keep stopping short.

## What this session changed

- **Test litter fix (cousin of the "ledger is the only truth" problem).** `dispatchDetached` opens its log file before spawning, and the tests stub `spawn` but not `fs`. Every test run wrote zero-byte files into the real `data/audit/digest-autofix-logs/`: 1,831 of 2,003 files (993 `linear_BRO-9-*`, 838 `7-*`). Anyone reading that directory to judge dispatch history saw about 2,000 "dispatches" when the real count was 8 digest plus drain jobs. `LOG_DIR` now resolves to a per-process temp dir under `node:test` (and honours `DIGEST_AUTOFIX_LOG_DIR`). New test: `dispatchDetached: under node:test the log lands in the OS temp dir...`. The 1,831 existing junk files were deleted.

## Remaining improvements, ranked

1. **Split multi-cause conditions before dispatch.** For a condition whose health row names several independent failures (the red-streak case), file one card per cause, or tell the job to fix one cause and card the rest. Success criterion: no `job-stopped-short` outcomes whose cost exceeds $5 on a single-card scope.
2. **Make reconcile independent of the plan.** `runAutofix` returns early on an empty plan (`if (!Array.isArray(plan) || !plan.length) return []`), so outcome reconciliation (park state, spend breaker, effectiveness row) only runs on days with rows. Dispatch-to-outcome lag in the ledger is 5 days (9/14 to 9/19) and 13 days (9/19 to 10/2). Run `reconcileDigestOutcomes` before that early return. Verify first that the lag comes from this and not from jobs genuinely still running.
3. **Report cost per pass.** Passes average about $17 per card. Add dollars per passed card to the "Autofix: jobs actually succeeding" row so cost is visible next to the pass rate.
4. **Keep reading outcomes, not attempts.** Use the ledger's `card-pass`/`card-fail` and the canary row. Do not count log files.

Items 1 to 3 touch the dispatch layer (`scripts/lib/digest-autofix.js`), which requires `/second-opinion` or `/plan-review` before the first edit (CLAUDE.md section 18). Item 2 is the best next card: small, testable with a ledger fixture, and it makes the other metrics trustworthy sooner.

## Not changed on purpose

- The $12 spend breaker, the 3-per-run cap and the 72h persistence gate are intentional policy. Changing them is an owner cost decision, not a bug fix.
