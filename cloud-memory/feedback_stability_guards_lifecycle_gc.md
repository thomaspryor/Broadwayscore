---
name: Stability guards must distinguish lifecycle GC from data loss
description: Show/cast stability guards that snapshot before cleanup count expected lifecycle removals (closed-show GC, expired events) as scrape-driven data loss and abort the run.
type: feedback
originSessionId: 29f81bb0-5e0a-4173-be64-c52ae2ab1480
archived: true
---
Show- or cast-level stability guards that take a snapshot of `original` data and then count `removed = original \ updated` will fire on cleanup-driven removals — closed-show GC, orphan removal, expired events — not just real data loss. Caused `update-cast-changes.yml` to fail every run from 2026-04-19 onward (`scripts/scrape-cast-changes.js:1644`): the snapshot was taken at line 1556 before `cleanClosedShows` deleted 6 closed OB shows + 1 orphan test show, and the guard aborted at >5 removals.

**Why:** Cleanup steps (`cleanExpiredEvents`, `cleanClosedShows`) are deliberate lifecycle work, not corruption. The guard's purpose is to catch scrape-driven data loss (a source dropping all its hits). Conflating the two means every routine run that GCs ≥6 closed shows trips an abort.

**How to apply:** When adding or auditing a stability guard:
1. Identify which mutations between snapshot and validation are *intentional cleanup* vs *scrape work*.
2. Either snapshot AFTER cleanup (only safe if no scrape mutations need to be measured against pre-cleanup state) OR pass an `expectedRemovals` set into the guard so cleanup-removed items don't count.
3. The fix in `scrape-cast-changes.js`: pass `new Set(closedChanges.map(c => c.showId))` into `validateShowStability` and exclude those IDs from `removed`.

Same pattern applies to any future guard that compares pre/post states across a pipeline with intentional GC steps.
