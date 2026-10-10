---
name: outlet-registry alias canonicalization at read sites
description: Adding aliases to outlet-registry.json only affects normalizeOutlet — code reading raw outletId from review files must explicitly canonicalize, or aliases don't take effect.
type: feedback
originSessionId: e6cc9aba-2251-4534-9292-c270cf3a9afb
archived: true
---
When you add a legacy outletId to a canonical entry's `aliases` array (e.g. `"the-associated-press"` → `ap.aliases`), the alias only resolves when something calls `normalizeOutlet()`. Files on disk still carry the legacy `outletId` field as written; aliases don't rewrite stored data.

**Why:** discovered 2026-04-25 — added `the-associated-press` to `ap.aliases` to fix a recurring stranded file. CI test.yml went red because `audit-review-contamination.js` read `d.outletId` directly and compared raw "the-associated-press" against domain owner "washington-times". The alias never resolved at audit time.

**How to apply:** When adding registry aliases as a fix:
1. Confirm `normalizeOutlet('legacy-id')` returns canonical (the alias works).
2. **Grep every script that reads `d.outletId` or `f.split('--')[0]` for outlet identity.** Each must call `normalizeOutlet` before comparing/lookup. Today: `audit-review-contamination.js`, `audit-outlet-registry.js`, anything in `scripts/lib/score-routing.js`, rebuild writers.
3. Pattern fix in `audit-review-contamination.js` (commit 679e000399): `const internalOutlet = normalizeOutlet(d.outletId || f.split('--')[0])` — preserves raw form in the hit record under `rawInternalOutlet` for debugging.

The complement: rebuild writers should also canonicalize before writing outletId to new files, so future ingest produces canonical IDs. Until that happens, files with legacy IDs persist; aliases keep them readable but auditors must canonicalize.

**Closely related:** `feedback_recurring_backfill_means_broken_creator.md` — the legacy-ID problem usually means a writer somewhere isn't normalizing. Aliases are a band-aid; finding the writer is the durable fix. For the the-associated-press case, the writer is the show-score → review-text path in rebuild (still TBD).
