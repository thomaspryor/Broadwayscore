---
name: Conflict-mode > merge-mode for runtime file renames
description: When a runtime helper renames a file under a slug-changes-after-load contract, conflict-mode (return 'conflict', touch nothing) beats merge-mode (merge into dest, unlink source). Merge-mode is fragile under trailing writes from the caller.
type: feedback
originSessionId: 156306d9-7c3d-45c8-af0b-5b29da675785
archived: true
---
When a helper renames a file as a side-effect of a content change (e.g., criticName overwritten, then file slug recomputed), do NOT use merge-into-dest semantics — even with safe-write guards. Use conflict-mode: if dst exists, return `'conflict'` and TOUCH NEITHER FILE. Caller decides what to do (set `duplicateOf` marker, flag, queue for reconciliation).

**Why:** Caller code rarely operates only on the helper. Typically the caller reloads the in-memory `data` object and does its own trailing write to `review.filePath` (or equivalent). A helper that merged into dest then set `review.filePath = newPath` will silently lose the merge when the caller's trailing write lands at the new path with the unmerged in-memory `data`.

This was the PR #290 line-5069 corruption surface in `scripts/collect-review-texts.js`. The rename helper merged unique fields from source into dest at `newPath`, unlinked source, and updated `review.filePath = newPath`. The function continued executing and at line ~4987 wrote `data` back to `review.filePath`. Result: dest's pre-merge state was overwritten by the caller's `data`, undoing the entire merge. Codex caught it on ship-check, PR was reverted.

**How to apply:** When designing a rename helper that may run mid-function:
1. On dst-exists: return `{ skipped: 'conflict' }` and leave both files untouched.
2. Caller sets `data.duplicateOf = newFilename` and KEEPS `review.filePath` at the SOURCE path. The trailing write lands on the duplicateOf-marked source. `validate-review-texts.js` skip-gate (or equivalent) catches the file before downstream consumers.
3. Add a regression test that explicitly asserts `review.filePath` STAYS at source on conflict — this is the line-5069 guard.

If batch reconciliation is needed (e.g., for a durable backfill), make the merge a SEPARATE script that doesn't run inside the runtime caller's loop. The backfill can safely merge because it doesn't have a trailing-write surface.

Origin: `34f637c5-416f-81a1-adf6-d02b51eb6b7b` (collect-review-texts rename asymmetry redesign), 2026-04-29. Related: `feedback_critic_override_must_rename_file.md`, `feedback_safe_write_review_merge_gotcha.md`.
