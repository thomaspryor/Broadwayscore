---
name: Commit data repo edits IMMEDIATELY — uncommitted edits get clobbered by background CI rebases
description: Stuart batch 2026-04-27 lost Stuart edits to broadway-scorecard-data shows.json AND broadway-review-texts files TWICE because background sessions ran pull --rebase which auto-stashed the dirty state and the stash was then dropped or the rebase reset working tree. Don't batch data edits.
type: feedback
originSessionId: b979be02-2974-4428-ab37-f8eadbd2bad6
---
Twice in one session the same Stuart edits were lost:
- Edit 1: 4 WftP review clears + 17 lbo-roundup flags + Flyby restore + Inter Alia ingest +
  Lifeline + Price (Marylebone) ingest. Wrote files to disk in batches, planning to commit at
  the end. Mid-session, a background process ran `pull --rebase` in `data/review-texts` which
  auto-stashed and rebased over them; my disk writes were gone after rebase finish.
- Edit 2: shows.json (WftP openingDate, Lifeline, Price). Same pattern — broadway-scorecard-data
  was clean when I started, my edits were uncommitted, a background pull restored to HEAD.

The data submodules (`data/review-texts`, `broadway-scorecard-data`) are SEPARATE git repos. A
worktree on the public repo doesn't isolate them. They are touched by:
- Codex CLI pre-tool hooks
- session-start `pull --rebase` checks
- CI workflows committing back during the same window
- Background rescore/recovery scripts in adjacent sessions

**Why:** Batched data edits sitting uncommitted on disk look identical to "no work in progress"
to a sibling session that runs `git pull --rebase`. Rebase autostashes, applies remote, attempts
to pop — if pop conflicts or the script aborts, the stash is preserved BUT later sessions see no
local-only commits and may safely "reset --hard" or pull again.

**Pushing when the shared checkout is dirty/behind (another session's WIP):** never pull/rebase it. `git fetch && git worktree add <scratch> --detach origin/main`, apply your file-scoped edits there, commit, `git push origin HEAD:main`, `git worktree remove` — used 5x cleanly on 2026-07-19 while byline-recovery owned the main review-texts checkout. Do NOT `git worktree remove` in a `&&` chain after a push that can fail non-fast-forward — a failed push leaves the commit only in that worktree (rebase+push from inside it first).

**How to apply:** For data repos with active CI traffic (`data/review-texts`,
`broadway-scorecard-data`):

1. Make a small set of edits (ONE logical batch — e.g. 4 review clears).
2. `git add` + `git commit` IMMEDIATELY (within minutes, not at session end).
3. `git push` IMMEDIATELY (so other sessions see your commit and won't blindly reset).
4. THEN make the next batch.

Worktrees do NOT protect data submodules. Per-batch commit/push is the only reliable
mechanism. Stash is unreliable mid-session because cross-session rebases can drop or
preserve-orphan stashes inconsistently.

Specific to this project: the `data/review-texts` repo has `.git` separate from the public repo's
worktree. Every edit there must commit-push; do NOT rely on the worktree pattern.
