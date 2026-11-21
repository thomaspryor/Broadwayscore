---
name: feedback_safewrite_temporal_guard_needs_date
description: "safeWriteReview's temporal-byline guard is inert unless newData carries publishDate/parsedDate — pass the date on any criticName backfill"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 71eaba5c-b9bb-4562-beba-3e630b35852a
---

`safeWriteReview(filePath, newData, {merge:true})` in `scripts/lib/review-write-guard.js` runs its temporal-byline guard (downgrades an attribution to a retired/deceased critic on an old-dated review → 'Unknown') **only when `newData` contains a `publishDate` or `parsedDate`** (the guard is gated `if (newData.criticName && (newData.publishDate||newData.parsedDate))`, ~line 355). With `merge:true` the existing date is merged in *after* the guard, so a call that passes `{criticName}` alone leaves the guard **completely inert** — no protection, silently.

**Why:** discovered on card #27 byline recovery. The driver wrote `{criticName, bylineRecoveredFrom}` and its own comment claimed the temporal guard would vet it; ship-check's adversarial pass caught that the guard never fired.

**How to apply:** any script that backfills/repairs `criticName` through `safeWriteReview` must also pass the file's existing `publishDate` (and `parsedDate`) in `newData`, or the temporal guard does nothing. Read them off the loaded record and include them. See `scripts/recover-unknown-bylines.js` for the corrected call. Related: [[feedback_manual_review_protection_fields.md]], [[feedback_protected_fields_every_write.md]].
