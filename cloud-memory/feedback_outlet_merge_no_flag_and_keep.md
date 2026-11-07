---
name: outlet-merge-no-flag-and-keep
description: "When merging duplicate outlet IDs, never leave a rejection-flagged loser file with corrected outletId next to the live winner — the rebuild folds it INTO the winner (flags + URL) and cascade-deletes it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2e06fa5b-767d-4270-bb96-26a8710118a5
---

During the 6-pair registry-duplicate outlet merge (2026-07-12, card 39b637c5-416f-8175), two loser files were kept as flagged tombstones (`not_a_review` / `wrongProduction`) with their internal `outletId` corrected to the winner's ID. The next rebuild MERGED the flagged tombstone into the unflagged same-outlet--same-critic winner file — the live scored star row inherited `rejectionReason` + the interview URL and silently dropped out of reviews.json — then cascade-deleted the tombstone (`duplicateClearReason: "cascade-cleared: sibling ... was deleted"`).

**Why:** findExistingReviewFile skips flagged files as merge *targets*, but the merge path doesn't check the *source* for rejection flags. A tombstone whose outletId+critic slug match a live file is a merge source.

**How to apply:** In outlet-ID merge migrations, for loser files that are worthless artifacts (interview stubs, wrong-production strays): DELETE them via `safeUnlinkReview` (write-guard lock contract) instead of flag-and-keep. Flag-and-keep is only safe when the filename prefix + internal outletId do NOT collide with a live sibling (e.g. duplicateOf-marked files whose target carries the same URL). Code-level prevention card: 39b637c5-416f-815e (merge path must refuse to fold rejection-flagged sources into unflagged targets) — delete this memory when that ships.
