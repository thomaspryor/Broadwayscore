---
name: reset+rsync push pattern wipes freshly-committed CI fields
description: Never use `git reset --hard origin/main && rsync local→repo` to resolve push rejections; it silently wipes CI-added fields that landed during the race window.
type: feedback
originSessionId: e21cf611-958e-43e9-b905-cbd9f28d4eda
---
When a push to broadway-review-texts (or any active-CI repo) is rejected due to remote having new commits, the shortcut 'git rebase --abort && git reset --hard origin/main && rsync local→repo' silently wipes any CI-added fields (llmScore, llmMetadata, ensembleData, pullQuote, etc.) that landed in the interim.

**Why:** The sequence resets to origin/main's state (which has the CI additions) but then rsync overwrites with the LOCAL copy (which lacks them). Net effect: CI work deleted.

**Observed twice on 2026-04-23 Beaches opening night:**
- After a scoring run committed llmScore to 10 beaches-2026 review files, I reset+rsync'd and the llmScore fields were gone. Had to recover by `git show <prior-commit>:path/file.json` and re-patch.
- Same pattern nuked 5 fresh LLM scores an hour later.

**How to apply:**
- Default to `git pull --rebase` ONLY. If conflicts, resolve per-file.
- If absolutely must use reset-hard, FIRST copy any CI-authored fields into the local files before rsync.
- Better: use a merge strategy that preserves unmentioned fields (`git pull --rebase -X theirs` for field additions, or field-level merge via a helper script).
- NEVER chain `reset --hard origin/main && rsync local→repo` as a push-rejection escape hatch.

**Recovery recipe when you've already wiped fields:**
```bash
cd ~/broadway-review-texts
# For each file you may have wiped:
git show <prior-commit>:path/file.json > /tmp/orig.json
# Then merge llmScore/llmMetadata/ensembleData from /tmp/orig.json into current file
```

**Related:**
- memory/feedback_restore_protected_fields.md — mentions restore-protected-fields.js; not wired into manual push helpers yet
- memory/feedback_symlink_aware_writes.md — similar class of "write-path forgets state" bugs
