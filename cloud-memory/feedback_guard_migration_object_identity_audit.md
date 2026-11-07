---
name: feedback-guard-migration-object-identity-audit
description: "When migrating callers onto a new load/save guard module (lock+merge pattern), grep specifically for raw-read-then-guard-save and object-reconstruction-before-save — import presence alone doesn't prove the merge fires"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a3a63e78-3991-4ff2-a5a9-a664bbe1b136
  modified: 2026-07-24T15:42:57.911Z
---

When building a `loadX()/saveX()` guard that snapshots the loaded object to detect concurrent changes (see `scripts/lib/shows-write-guard.js`), a caller "importing the guard" is not proof the merge protection actually engages. Two silent-bypass patterns recurred across 72+ migrated callers, found only by two rounds of independent adversarial review (Claude/Opus + Codex, each run twice):

1. **Raw-read-then-guard-save**: caller does `JSON.parse(fs.readFileSync(PATH))` instead of `loadX()`, then calls `saveX(data)`. The guard's WeakMap snapshot lookup misses (no snapshot was ever recorded for `data`), so `saveX()` silently falls back to unmerged overwrite — safe, but no better than the pre-guard behavior the whole migration exists to fix. Found in `normalize-venues.js`, `fix-shared-ibdb-urls.js` (worse: used `require(PATH)`, hitting Node's module cache).
2. **Object-reconstruction-before-save**: caller does `saveX({ ...data, field: newArray })` or similar instead of mutating the loaded object in place. The rebuilt object is a *different* reference than what `loadX()` snapshotted, so the identity check fails the same way. Found in `backfill-market.js`, `execute-approved-fix.js`, `auto-fix-feedback-bug.js` (all three: correctly imported the guard, correctly called `loadX()`, and still broke the merge at the final `saveX()` call).

**Why to apply:** a codemod or manual migration that only checks "does this file `require('./lib/x-write-guard')`" will report 100% migrated while several callers get zero actual concurrent-writer protection. The bug is invisible in normal operation (single-writer runs work identically either way) and only manifests as data loss during an actual race — exactly the failure mode the guard exists to prevent, silently reintroduced.

**How to apply:** when auditing (or adversarially reviewing) a caller migration onto this pattern, grep for two things beyond import presence: (a) every `readFileSync`/`require` of the target path that ISN'T `loadX()`, and (b) every `saveX(...)` call argument that isn't the exact identifier `loadX()` returned (spread/rebuild syntax like `{ ...data, ... }` or a differently-named local variable). Directly relevant to [[feedback_worktree_code_changes]]-class migrations — next candidate is the commercial.json/audience-buzz.json generalization (Notion card, dispatched as task #422, 2026-07-24) which will hit the identical bug class.
