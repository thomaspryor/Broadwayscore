---
name: feedback_self_referential_duplicate_pointers
description: duplicateOf/duplicateTextOf can point at the file itself after byline renames — silently drops reviews; audit + write-guard self-heal both fields now
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 01818bd9-0b9c-4e6d-a366-7b1512af86c3
---

**What happened (2026-07-09):** 119 review-text files carried duplicate pointers that made them invisible to every rebuild: 93 `duplicateOf` self-refs, 23 `duplicateTextOf` self-refs, 3 dangling `duplicateTextOf`. JCS West End 2026 lost Time Out/LBO/Radio Times/Cambridge on opening night and the broadcast drift gate blocked 17 runs.

**Why:** `safeRenameReview` renames a fingerprint-flagged `outlet--unknown.json` ONTO its pointer target once the byline is identified (e.g. `timeout-london--unknown.json` flagged `duplicateTextOf: timeout-london--andrzej-lukowski.json`, then renamed to exactly that name). The pointer rides along and the file becomes a "duplicate of itself" — every includability predicate rejects it. The write-time self-heal only covered `duplicateOf`, and the CI audit only checked `duplicateOf` URL mismatches, so the class accumulated invisibly.

**How to apply:**
- When reviews are missing and flags look clean, check `duplicateTextOf` too — my first scan missed it by only listing `duplicateOf`. Self-ref test: `d.duplicateTextOf === basename` or `d.duplicateOf === basename`.
- Fixed 3 layers (commit 6645791381): `safeRenameReview` strips pointers equal to the destination basename; `safeWriteReview` self-heals `duplicateTextOf` self-ref + dangling (NOT url-mismatch — syndicated text at different URLs is what the field encodes); `audit-duplicate-of-url-mismatch.js` detects `self-reference` (both fields) + `duplicateTextOf` `sibling-missing`, and `--fix` clears the right field. Daily self-heal `clear-stale-duplicate-of.yml` now covers the class.
- Clearing `duplicateTextOf` must NOT set `duplicateTextOfCleared` — that would block the fingerprint pass from re-flagging with a correct pointer.
- Sentinel-valued pointers (`duplicateOf: "northjerseycom"`, `"known-outlet-copy-exists"`, ~18 files) are deliberately NOT auto-cleared — non-`.json` values encode intent from old scripts; report-only.
- Drift-gate reading: `actual > expected` means a rebuild would DROP reviews (stale flags just landed or files got flagged); `expected > actual` means recovered/unflagged files haven't been rebuilt in yet.

Related: [[feedback_duplicate_of_url_mismatch]], [[feedback_manual_review_protection_fields]], [[feedback_pending_no_byline_strand_drain]]
