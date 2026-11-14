---
name: duplicate-of-url-mismatch
description: "A.duplicateOf=B without matching URLs is a stale flag, not a real dupe — silently suppresses legitimate reviews"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9aa69087-81a3-4c0d-8e2a-e2e42e1a4ff9
---

When `A.duplicateOf = B` but `A.url ≠ B.url`, the duplicate flag is stale and is suppressing a legitimate review from the rebuild.

**Why:** Collision detection runs at write time on `newData.url` vs sibling URLs. If a URL is briefly "corrected" to a colliding value (e.g. `urlCorrectedFrom` chain), the duplicate flag fires — and then sticks even after the URL is restored. The Sommers/Bernardo case (Can I Be Frank, 2026-05-24) silently dropped a T2 NYSR review for 9 months because of this. A bulk audit found 397 instances across the catalog (many: stale syndication pointers, critic-name corrections like greenblat→greenblatt that left a dupe pointer to a renamed/deleted file).

**How to apply:**
- Self-heal is wired into `scripts/lib/review-write-guard.js`: if existing `duplicateOf` points at a sibling whose URL no longer matches, the flag clears at next write. Also skips collision check entirely when `urlCorrectedFrom` is set (transient state).
- CI gate: `scripts/audit-duplicate-of-url-mismatch.js` runs in `test.yml` and fails on any stale flag.
- To clear locally: `node scripts/audit-duplicate-of-url-mismatch.js --fix`.
- For text-based dupes (syndication, same critic at two outlets), use `duplicateTextOf` — NOT `duplicateOf`. `duplicateOf` is URL-only.

Related: [[feedback_worktree_code_changes]], [[notion-brain-workflow]].
