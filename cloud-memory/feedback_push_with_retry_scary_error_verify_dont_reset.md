---
name: push-with-retry.sh scary failure text can still mean success
description: "reset+cherry-pick fallback failed AND could not restore HEAD" from scripts/lib/push-with-retry.sh does not necessarily mean work was lost — verify with a fresh fetch before touching git destructively.
metadata:
  type: feedback
---

`scripts/lib/push-with-retry.sh` printed `::error::push-with-retry: reset+cherry-pick fallback failed AND could not restore HEAD to <sha> — local main may be stranded ... Recover manually with: git reset --hard <sha>` after a push race (another concurrent session pushed to origin/main between my fetch and push). The message reads like an emergency.

**What was actually true:** the script HAD succeeded in flattening my commit onto the fresh origin tip (a new SHA, same content, since it went through cherry-pick not a direct merge) — it just also left `.git`'s cherry-pick sequencer state dangling (no `CHERRY_PICK_HEAD` file, but `git status` still reported "Cherry-pick currently in progress" and a stale `.git/sequencer/todo`) and reported the abort-back-to-original-HEAD step as failed on top of an already-successful replay.

**How to apply:** on this exact error text, do NOT run the suggested `git reset --hard <sha>` and do NOT panic-abort anything. Instead:
1. `git status --short` — check for actual unmerged (`UU`) paths. None means no real conflict survived.
2. `git cherry-pick --quit` — clears stale sequencer state (safe: no-op if nothing pending, doesn't touch HEAD or files).
3. `git fetch origin main` then `git rev-list --left-right --count HEAD...origin/main` — get the REAL ahead/behind count against a fresh remote view (a pre-fetch comparison can be stale by the exact race that just happened).
4. Confirm your file changes are actually present in the working tree/HEAD (grep for something you added) before concluding anything was lost.

Only escalate to something destructive if step 1 shows real unmerged paths or step 4 shows your content missing. In this session (BRO-3392, 2026-09-15) all four checks came back clean — the push had genuinely succeeded — and after the flattening the content-identical branch's `git branch -d` correctly failed with "not fully merged" (different SHA, cherry-picked not merged) and needed `git branch -D` after confirming content match, not a signal of anything wrong.

**Multi-session context:** this repo has 20+ concurrent Claude Code sessions sharing one local `main` checkout (`~/Broadwayscore`), so push races and other sessions' in-progress `MERGE_HEAD`/staged-but-unrelated-file states in the SAME working tree are expected background noise, not incidents to fix. See [[feedback_parallel_worktree_race.md]] for the broader pattern.
