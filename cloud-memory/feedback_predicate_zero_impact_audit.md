---
name: Predicate firing ≠ practical impact — audit data co-occurrence
description: A new exclusion-override predicate can fire correctly while having zero real-world effect because other gates always exclude first.
type: feedback
originSessionId: e29ab79b-3895-44e3-9331-3255dec6b39b
archived: true
---
When you add a new override that lets a previously-excluded review pass through
a gate (e.g. `isLikelyStaleWrongShow` overrides `wrongShow=true`), don't assume
the predicate's correctness translates to practical impact. Audit the data for
flag co-occurrence first.

**Real incident (2026-04-26, Notion 34e637c5-416f-8121 + 815c):**
- `isLikelyStaleWrongShow` predicate works correctly (fires for ~5/328 wrongShow
  files probed). Show context plumbed through 4 callers. Tests pass.
- BUT: 99% of `wrongShow=true` files ALSO have `contentTier='invalid'` which is
  evaluated FIRST in the gate and independently excludes. 25% also have
  `wrongProduction=true`. Only 21 of 2,177 wrongShow files have wrongShow as
  the sole exclusion. Of those 21, 0 pass the strict predicate.
- Net result: the override is correctly wired and future-proofed but **flips
  zero files in current production data**.

**Why:** flag-setting code paths often set multiple flags together (the
cross-attribution audit sets BOTH wrongShow AND contentTier=invalid; the LLM
ensemble rejection sets BOTH wrongShow AND rejectedAt). A new override that
targets ONE of those flags doesn't help when the file is already excluded by
the OTHER.

**How to apply:**
- Before shipping a gate-side override, count files where the target flag is
  the SOLE blocker. If <1% of flagged files, the override has near-zero impact.
  Decide: drop it, expand to override the co-flag too, or keep as
  documentation-only.
- The audit query takes 2 minutes. Run it before declaring victory:
  ```js
  // For target flag X, count files where X is set but NO other gate excludes
  const sole = files.filter(f => f[X] === true
    && !f.duplicateOf && !f.wrongProduction && !f.wrongAttribution
    && f.contentTier !== 'invalid' && !f.rejectionReason);
  ```
- The fix usually isn't "make the predicate stricter" — it's "fix the
  upstream code that sets co-flags together when they shouldn't be."
- Same gotcha applies to inclusion predicates that look at one signal in
  isolation when the upstream code emits a bundle.

See: scripts/lib/is-scoreable.js gate ordering, Notion 34e637c5-416f-815c.
