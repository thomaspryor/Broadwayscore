---
name: closure-addeddate-restamp
description: "Cast-changes closure addedDate re-stamps make the newsletter re-announce months-old closings; check castData addedDates vs prior snapshots when auditing \"Recently Announced Closings\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e66be726-cbbf-4f92-8b73-2825d5378835
---

The weekly newsletter's "Recently Announced Closings" and lede key on cast-changes.json closure `addedDate` (= first public announcement, write-once). Three separate mechanisms have re-stamped it to "today," each making the newsletter present months-old closings as this-week news (2026-05-27 bulk re-stamp, 2026-07-11 Moulin Rouge/Ragtime/Titanique incident):

1. `mergeEvents` Object.assign on source upgrade (fixed 2026-05-30, `mergePreservingAddedDate`).
2. `dedupeByPersonShow` kept the NEWEST-addedDate record when collapsing same-name/type/role events (fixed 2026-07-11: pin earliest).
3. `findClosureDupe` matched closures by date only — an old article carries the pre-extension closing date, slips past, becomes a new row stamped today, then `reconcileClosureDateWithClosingDate` rewrites it into an identical-date twin (fixed 2026-07-11: match ANY closure; a production has one upcoming closure, reconcile owns the date).

**Why:** Full-article sweeps (`update-cast-changes.yml` workflow_dispatch with source=articles) re-extract years of old Playbill articles; every extracted event is stamped `addedDate = TODAY`, so any dedupe/merge path that lets the fresh copy win moves the write-once date forward.

**How to apply:**
- When auditing a newsletter draft, diff closure `addedDate`s against a pre-sweep git snapshot of data/cast-changes.json (`git log -- data/cast-changes.json`); events "added" the same day as an article sweep are suspect. Wrong sourceUrls (cast-addition or begins-performances articles cited for a "closing announcement") are the tell.
- Repair values: `scripts/repair-closure-added-dates.js` holds verified first-announcement dates.
- Known trade-off of any-closure matching: a genuinely NEW closing announcement for a previously-extended show inherits the original addedDate and will NOT resurface in "Recently Announced Closings." Accepted 2026-07-11 (stale re-announcements were frequent and embarrassing; true re-announcements are rare).
- The lede candidate feed in `scripts/newsletter/generate.mjs` must mirror the section's suppression filters (`recentAnnouncedIds`) — lede/body divergence was the Titanique symptom. See [[feedback_includables_predicates_must_be_canonical]] for the general "mirror the canonical predicate" rule.
