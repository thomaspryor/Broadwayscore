# BRO-1703 state (2026-10-05)
DONE: dup-dispatch guard (scripts/lib/dispatch-guards.js makeProvablyDeadFn, wired in bsc-next.js x2 + linear-next.js) ignores a title-matched shell only when ledger has a 'dead' row for that ref+task AND cmux says dead AND no wrapper process. Tests in scripts/lib/dispatch-guards.test.mjs; 1217 dispatcher-related tests + tsc pass. second-opinion + ship-check recorded.
LANDING: tip aa9cfe92f9 pushed to origin/land/job/linear-BRO-1703-muvkoan9; land.yml run 37359729207 Checks=success, Land job was cancelled once (queue), re-run queued.
REMAINING: confirm on main, then run the check, then report done.
NEXT: git fetch origin main && git merge-base --is-ancestor aa9cfe92f9 origin/main && node --test scripts/lib/dispatch-guards.test.mjs
NOT DONE (out of scope of this commit): bsc-prune --reconcile mode; headless fallback on launch-verify failure (zombie sweep + slow-boot wait already cover most).
