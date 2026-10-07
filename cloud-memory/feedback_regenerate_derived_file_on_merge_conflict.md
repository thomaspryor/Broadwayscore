---
name: feedback_regenerate_derived_file_on_merge_conflict
description: "Merge conflict on a machine-derived JSON (baseline lists, generated indexes) — regenerate from the merged source, don't pick a side"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 700bdf0c-e85d-49a7-ae49-c977ec35df79
  modified: 2026-07-26T22:50:44.460Z
---

When a git merge conflict lands in a file that's mechanically derived from a script (e.g. `scripts/.help-flag-safety-baseline.json`, generated via `--update-baseline`), resolve it by taking either side as a placeholder (`git checkout --ours -- <file>`) then immediately regenerating the file from the merged, current tree state — never hand-merge the conflict markers or pick a side as final.

**Why:** hit this live during [[project_ob_venue_historical_backfill.md]]-adjacent work on task #551 — a worktree session broadened `audit-help-flag-safety.js`'s detection and grew the baseline 128→207, while a concurrent session (#545) was independently retrofitting scripts off the old baseline and shrinking it. The merge conflicted on `scripts/.help-flag-safety-baseline.json`. Picking either side would have silently dropped the other session's real work (either losing my 79 newly-surfaced entries, or losing their retrofit-driven removals). Regenerating via `node scripts/audit-help-flag-safety.js --update-baseline` after the two code files merged cleanly produced the mathematically correct union automatically.

**How to apply:** applies to any file whose content is a pure function of source code plus a `--update-*`/`--regenerate` flag (baseline lists, generated manifests, computed indexes). Does NOT apply to files with independently-authored content per side (e.g. two people's prose additions to the same doc) — those need real reading and manual reconciliation.
