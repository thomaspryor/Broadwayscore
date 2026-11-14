---
name: must-match-comment-is-a-bug
description: "When you see a `// must match X` or `// keep in sync with Y` comment in code, treat it as a drift bug to fix, not a documentation note to preserve."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4393b6e0-e6f1-40d2-8318-0c91374a470d
---

When you see a code comment like `// must match src/config/scoring.ts` or
`// keep in sync with X`, that comment IS the bug — it's a manual-sync
canonical waiting to drift. Don't preserve it; eliminate it.

**Why:** In this codebase, `TIER_WEIGHTS` had FOUR copies — `src/config/scoring.ts`,
`src/lib/scoring.ts:99` (`// must match src/config/scoring.ts`), `scripts/lib/outlet-tiers.js`,
`scripts/lib/compute-critic-score.js` (commented "single source of truth" but
actually duplicated). Hand-synced, with comments asking future-you to keep them
synced. Codex (2026-05-17) flagged that "must match" comments are exactly the
bug class an invariant test was trying to prevent. Fixed by having three of the
four import from a single canonical. Drift now impossible by construction.

**How to apply:**
1. When editing code, grep for `must match`, `keep in sync`, `same as X`, `mirror`, `duplicated in`.
2. For each: ask "can I import from a single source?" If yes, refactor and delete
   the duplicate.
3. If a duplicate must exist (e.g., crossing TS↔JS or repo boundaries), add a
   runtime invariant test that compares the two — see `tests/unit/tier-config-consistency.test.ts`
   for the pattern (asserts TS `TIER_WEIGHTS` keys === JS `TIER_WEIGHTS` keys).
4. **Never** add a new "must match" comment without also adding the test.

Related: [[outlet-tiers-two-sources]] (historical incident), [[scoring-delta-required]]
(scoring-watchlist edits must run scoring-delta.js — touched
`src/lib/scoring.ts` to eliminate the 4th canonical, ran the gate, zero deltas).
