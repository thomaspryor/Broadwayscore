---
name: feedback_compound_shell_git_traps
description: "zsh unquoted vars don't word-split (use loops/node files); never chain `git stash pop` after a conditional `stash push` — pop hits ANOTHER session's stash when nothing was saved; after a rejected push of a worktree MERGE commit use pull --no-rebase (rebase flattens the merge → add/add conflicts on the next worktree merge)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fc18b1f-6174-4c6a-b243-9b51c71e27b1
---

Two compound-command traps that each bit multiple times in one session (2026-07-12/13):

**1. zsh does not word-split unquoted variables.** `FILES="a b c"; git restore --staged $FILES` passes ONE pathspec `"a b c"` (fails); `MK="node script.js"; $MK args` tries to exec a binary literally named `node script.js`. Bash-isms silently break. **Fix:** iterate (`for f in a b c; do ...done`), or write the whole harness as a node script file and invoke it — no interpolation surface at all.

**2. `git stash push` → work → `git stash pop` chains are unsafe in this repo.** `stash push` saves NOTHING when the tree is clean ("No local changes to save") — the later `pop` then pops a DIFFERENT, pre-existing stash from a parallel session onto main, and a follow-up `stash drop` deletes yet another one. This repo always has parallel sessions' stashes present. **Fix:** never pop unconditionally. Either check the push actually saved (`git stash push ... | grep -q "Saved"` and only then pop), or skip the stash entirely when `git status --porcelain` is empty. Dropped stashes are recoverable by the hash printed at drop time (`git stash apply <hash>`).

**Also (same family, from feedback_prepush_gate_stash_push_parser):** the word `push` in `git stash push` confuses the pre-push hook's target parser — keep `git push` in its own command.

**3. `git pull --rebase` after a rejected push of a worktree merge commit flattens the merge (2026-07-13).** Sequence that bit: merge worktree branch → main, push rejected (remote advanced), `git pull --rebase` — rebase REWRITES the merge as flat cherry-picked commits with new SHAs. Main now has a *copy* of the worktree commits with no shared ancestry, so the NEXT `git merge <worktree-branch>` hits content + add/add conflicts on every file the branch touched. **Fix:** when integrating a worktree merge into a moved remote, use `git pull --no-rebase` (merge), or rebase the WORKTREE BRANCH onto origin/main and re-merge. If already bitten: resolve with `git checkout --theirs <files>` (worktree branch versions are the superset) and verify `git diff --cached <branch> -- <files>` is empty.
