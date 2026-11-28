---
name: feedback-merge-script-success-hides-content-clobber
description: "merge-worktree-to-main.sh printing CONFLICT + then eventually ✅ success does not mean your content landed — a concurrent session's conflict resolution can silently discard your commit's content in favor of an older version"
metadata:
  type: feedback
  originSessionId: 48a68c50-0d08-43be-8648-4e3539f70499
  modified: 2026-08-20T16:23:28.360Z
---

`scripts/merge-worktree-to-main.sh` can print `CONFLICT (add/add)` mid-run, then on a LATER invocation report `✅ integrated and verified on origin` — and the file-presence verification it runs (`✓ path/to/file`) only proves the path exists on origin/main, not that ITS CONTENT is yours. Between the conflict and the eventual success, something else touching the shared main checkout (a concurrent session, or the script's own stash-pop-conflict recovery) can resolve the add/add conflict "in favor of origin" — silently discarding your commit's content and keeping an OLDER version at that path.

**Why:** live incident (BRO-376, 2026-08-19) — a commit that redacted a real PII leak hit an add/add conflict during landing on the shared main checkout. A later merge commit (`Merge origin/main: resolve BRO-376 exporter AA-conflicts in favor of origin`) resolved it by keeping origin's OLDER, un-redacted content, silently reverting the fix. `git merge-base --is-ancestor <my-fix-sha> origin/main` returned NO even though the merge script's own presence-check had passed on a prior run.

**How to apply:** after ANY `merge-worktree-to-main.sh` run that printed `CONFLICT` at any point (even if the run eventually reports ✅), directly diff or grep origin/main's actual file CONTENT for your specific change — don't trust file presence alone. `git merge-base --is-ancestor <your-commit-sha> origin/main` is the fast, reliable check: it answers "is my exact commit really in this history," which presence-checking cannot. Especially critical after any session touching PII/secrets/security-sensitive content, where a silently-reverted fix is a live re-exposure, not just a lost commit.
