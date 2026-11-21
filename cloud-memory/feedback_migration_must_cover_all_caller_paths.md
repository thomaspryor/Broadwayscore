---
name: Migration must cover all CALLER paths, not just the helper internals
description: When migrating a helper to honor a new contract (e.g. _locked), the helper change isn't enough. Audit every caller for adjacent raw fs operations the helper doesn't cover. Fix every site, or the bypass survives.
type: feedback
originSessionId: 156306d9-7c3d-45c8-af0b-5b29da675785
archived: true
---
When a helper-internal change tightens a contract (`safeRenameReview` honors source `_locked`), the migration is incomplete until every adjacent caller path that ALSO does topology-class operations is migrated too. The helper might handle the rename, but the caller often has a sibling raw `fs.unlinkSync` for the duplicate-detected path that bypasses the lock entirely.

**Why:** Helpers are designed for one operation. Callers compose multiple. A "rename or skip-as-duplicate" caller has TWO topology ops (rename + delete-on-dup), and migrating only the first leaves the second unguarded. A locked file marked as duplicate would be silently destroyed.

**How to apply:** When migrating to a new helper contract:
1. After updating the helper, grep the caller files for ALL raw `fs.renameSync` / `fs.unlinkSync` / `fs.writeFileSync` calls to the same path family.
2. Each one is a candidate for migration. Don't trust your initial mental model of "the helper's path is the only path."
3. Spawn a code-reviewer subagent or run `/ship-check` — these catch sibling-path bypasses that close-reading misses.

Real example, 2026-04-29: `scripts/backfill-unknown-critics.js`'s `updateReviewFile()` rename path was migrated to `safeRenameReview` (honors source `_locked`). But the caller at lines 215, 315 had `if (result.duplicate) fs.unlinkSync(u.filePath)` — a separate topology op that survived migration. Claude QA subagent caught it. A locked source flagged as duplicate-of-canonical would have been silently destroyed.

Same pattern: `cleanup-phantom-outlets.js` — pre-migration had `mergeReviews + writeFileSync(canonical) + unlinkSync(phantom)`. Migrating only the writeFileSync call would leave phantom-unlink unguarded. Both writes need helpers.

Origin: ship-check round on `34e637c5-416f-81c8-995d-d25790624d32` (topology preservation), 2026-04-29. Related: `feedback_audit_every_dispatch_path.md` (broader pattern of "every caller of a routing change needs the same logic").
