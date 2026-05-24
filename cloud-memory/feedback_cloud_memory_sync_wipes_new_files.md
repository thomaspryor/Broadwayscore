---
name: cloud-memory-sync-wipes-new-files
description: cloud-memory sync commits ("sync from master" pattern) DELETE files written by parallel sessions if those files aren't in the master source. Caught 2026-05-24 when commit 03a114a343 wiped feedback_nonprofit_venue_vs_production.md 12 minutes after a parallel session committed it.
metadata:
  type: feedback
---

A parallel session ran `cloud-memory: sync condensed format + 25 new feedback memos` (commit 03a114a343) that included `--- /dev/null` diffs for files written by other parallel sessions within the same hour. The sync used a master source (likely `~/.claude/projects/.../memory/`) as ground truth and replaced cloud-memory contents wholesale, deleting newly-added files that hadn't propagated to the master yet.

**Symptom:** A memo I committed at 12:48 was missing from main at 17:15 (ship-check Read failed with "file does not exist"). MEMORY.md index entry survived because that file was already tracked + the sync merged its content. The standalone memo file was new, so the sync's "replace from master" pattern saw it as not-in-master and deleted it.

**Why:** Cloud-memory has multiple writers (parallel sessions, local + cloud Claude Code). The sync script's mental model is "master is the source of truth, sync from master to repo" — which silently drops anything in the repo that isn't in master. The opposite pattern ("repo is the source of truth, merge into master") would be safer for new files.

**How to apply:**
1. **Before running any cloud-memory sync**, list new files in `cloud-memory/` not yet in master — those are at risk. Treat sync as a merge, not replace.
2. **When restoring a wiped file**, the source of truth is `git show <my-commit>:<path>` — git history is the only reliable archive.
3. **Index-entry survival is not enough** — MEMORY.md can list a file that's been deleted from the repo (zombie reference).
4. After a sync commit lands in main, audit recent local files: `git log --since="1 day ago" --diff-filter=D --name-only cloud-memory/` reveals deletions to investigate.
5. Same pattern as [[parallel-worktree-race]] and [[reset-rsync-wipes-ci-fields]] — wholesale replacement of multi-writer state always silently loses recent additions.

**Recovery recipe:**
```bash
# Find my commit that originally added the file
git log --all --diff-filter=A -- cloud-memory/feedback_FOO.md
# Recover content from that commit
git show <sha>:cloud-memory/feedback_FOO.md > cloud-memory/feedback_FOO.md
git add + commit + push
```

**Related:** [[parallel-worktree-race]], [[reset-rsync-wipes-ci-fields]], [[silent-merge-loss-on-reformat]].
