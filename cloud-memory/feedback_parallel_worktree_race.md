---
name: Parallel worktree sessions race on the same card
description: When multiple sessions are handed the same multi-issue Notion card, they collide — no claim mechanism exists. Detect early by re-pulling main before Edit, not just before merge.
type: feedback
originSessionId: ea333588-eda7-4271-bbf8-49081b096e66
---
Three parallel sessions worked on the same parent Notion card (WE long-runner CV hardening 34c637c5-416f-812b) on 2026-04-24. They all implemented the same issues (1-4) independently in their own worktrees. Only the first two to merge won; the third (this session) discarded ~600 lines of duplicate work after a 4-file merge conflict.

**Why:** `EnterWorktree` branches from HEAD at session start. If another session's commit lands on main 20 minutes later, the worktree is silently stale. `git pull origin main` before merge is too late — the duplicate work is already written.

**How to apply:**
- When picking up a multi-issue card, `git -C /Users/tompryor/Broadwayscore fetch origin && git log origin/main --since="30 minutes ago" --grep="<card-id-prefix>"` BEFORE starting implementation. If another session shipped something on the card in the last window, that issue is likely done.
- For each issue before writing code: grep main's `scripts/lib/` for the filename you're about to create. A file named `long-runner-registry.js` vs `show-long-run.js` is a near-collision that only surfaces at merge time.
- If the Notion card itself has been updated mid-session (new outcomes, sub-cards filed), treat it as a signal that another session is active.
- Cheap heuristic: `node scripts/notion-brain.js search --status "In progress"` — if two cards reference the same parent ID, coordinate or narrow scope.

**Why:** Engineering the "right" fix twice is waste; the second implementation never ships regardless of quality. The small upfront check (30s of greps) prevents hour-scale duplicate work.

## Main repo working tree can be mid-conflict from another session (2026-07-14)
`git checkout main && git merge <worktree-branch>` in the MAIN repo's working directory can hit `error: you need to resolve your current index first` — another parallel session left main's working tree with unrelated staged/conflicted files (e.g. mid-resolution of a `.github/workflows/test.yml` conflict from its own merge). This is not your conflict to resolve — you don't have context on the right resolution, and `git merge --abort` or force-checkout could destroy that session's in-progress work.

**Fix:** don't touch the main repo's dirty state. From the worktree, `git push origin <branch>`, then `gh pr create --base main --head <branch>` and `gh pr merge <PR> --merge` — this is a server-side GitHub merge that never touches the local main repo's working directory at all. Confirmed safe: the other session's conflict resolution is untouched, your branch lands on origin/main via the API.

## High-churn main: manual fetch/rebase/push loop can lose every race (2026-07-19)
During a burst of concurrent worktree sessions all merging to main (observed: 6 consecutive `git push origin <branch>:main` rejections in ~5 minutes, each against a DIFFERENT new tip), a manual `git fetch origin main && git rebase origin/main && git push` loop kept losing — by the time local verification (tests) finished, another session had already pushed again. Eventually won by shrinking the loop (skip re-running the full test suite on every retry once a rebase reports zero conflicts — a conflict-free rebase against unrelated files doesn't need re-verification) and retrying immediately.

**Better fix for next time:** reach for `gh pr create --base main --head <branch>` + `gh pr merge <PR> --merge --auto` (or plain `--merge` once mergeable) instead of a manual retry loop — same fix already documented above for the "dirty main working tree" case, but it also solves THIS race: GitHub resolves the fast-forward server-side, so you're not manually racing every other session's push. Should have reached for this immediately instead of 6 manual cycles.

## test.yml unit-test batch is a merge-conflict magnet (2026-07-11)
`.github/workflows/test.yml`'s unit-test batch is ONE giant `node --test <200 files>` line. When 2+ parallel worktree sessions each register a new `*.test.mjs`, that line conflicts on EVERY merge, and a careless conflict resolution silently DROPS a session's registration → the `orphan-test` audit (`Audit — no orphan unit tests`) fails main red on the next push, and/or the same file gets registered twice (harmless but runs twice). This session lost `we-gate-proving.test.mjs`'s registration in a merge and hit it. Fix pattern: after ANY merge that touched test.yml, re-grep `grep -c '<yourtest>.test.mjs' test.yml` (expect exactly 1) before pushing; resolve conflicts by taking origin's line and re-inserting your test next to a stable anchor (e.g. `bww-rr-discover.test.mjs`), never by picking one whole side.
