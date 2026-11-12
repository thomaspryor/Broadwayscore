# BRO-7276 state
Done: 3 commits on job/linear-BRO-7276-mwcr1dcv (36f6747846c, 0630c6bd4b7, 2e5a41bc1d6); first land run refused on 3 repo invariants (audit table, orphaned-writes exempt, rmSync retries); fixed in the 4th commit and re-pushed to land/job/linear-BRO-7276-mwcr1dcv.
Remaining if land failed: re-run `scripts/merge-worktree-to-main.sh`, then
`node scripts/linear-session.js report --issue=BRO-7276 --status=paused ...` with RECHECK-AFTER 21 days after land.
Residual (not fixed): scripts/lib/board-closer.js recoveredComment/sweep runs snapshot-mode check (no --live); only matters if alert ledger marks a stuck rollup resolved.
