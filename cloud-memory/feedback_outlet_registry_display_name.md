---
name: Outlet display name source of truth
description: When renaming an outlet's display name, edit data/outlet-registry.json — other config files are ignored by rebuild
type: feedback
originSessionId: 23f07b36-243e-480b-8284-e11f02121088
---
When renaming an outlet's display name (e.g. "One-Minute Critic" → "1 Minute Critic"), the source of truth is `data/outlet-registry.json`. Rebuild resolves via `getOutletDisplayName()` in `scripts/lib/review-normalization.js` which reads the registry FIRST; the built-in fallback table at the bottom of that file is only used if the outlet isn't in the registry.

**Why:** Editing only `src/config/outlet-tiers.json` and `scripts/config/critic-outlets.json` and running rebuild left the review.outlet field set to the registry's old displayName across all 45 reviews in reviews.json — which then propagated to public/data/shows/*.json and the live site. Discovered 2026-04-20 during 1MC rename: had to trigger rebuild twice (first run propagated outlet field from registry, overriding the review-text files I'd normalized).

**How to apply:** Outlet rename checklist:
1. `data/outlet-registry.json` → `displayName` field (SOURCE OF TRUTH)
2. `scripts/lib/review-normalization.js` → fallback table (defensive)
3. `src/config/outlet-tiers.json` → `name` (used by some UI code paths)
4. `src/config/outlet-logos.ts` → display-name keys (used for logo/color lookup)
5. `scripts/config/critic-outlets.json` → `name` (used by gather scripts)
6. Data files: `data/review-texts/*/outlet-id--*.json` `outlet` field (normalize with a script)
7. Trigger rebuild — it regenerates reviews.json with the correct display name
