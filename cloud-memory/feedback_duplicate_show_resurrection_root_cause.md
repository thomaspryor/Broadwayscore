---
name: feedback_duplicate_show_resurrection_root_cause
description: "A deleted duplicate show.json entry that comes back after 24h is almost always discover-new-shows.js re-adding it, not a push/merge race — check checkForDuplicate()/isMultiProduction() gaps first"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1d1cb5a3-d575-4b37-857e-2a22ba7b56d4
  modified: 2026-09-13T16:14:35.039Z
---

When a show deleted from shows.json (a duplicate-show cleanup) reappears
within a day, the first hypothesis should be **discover-new-shows.js's own
discovery step re-creating it on its next scheduled run** (SERP/Playbill-tag
discovery calls `checkForDuplicate()`/`isMultiProduction()` against the
current catalog every run — deleting the entry once does nothing to stop the
next run from re-discovering the same external listing), not a push/merge
race in `scripts/lib/json-write-guard.js` or `push-core-data/action.yml`.

**Why:** two real incidents (2026-09-12/13, BRO-3191) both looked identical
to a stale-checkout merge artifact at first — the resurrected record had
OLDER, less-enriched data (status "previews", null openingDate) than what
was deleted, which reads exactly like a stale snapshot winning a merge. It
wasn't. `gh run view <update-shows-run-id> --log` showed the actual
SERP/Playbill-tag discovery step re-adding it, with the discovery pipeline's
OWN duplicate-corroboration warning ("possible cloned date; verify") firing
in the log but never blocking the add. The real bugs were in
`scripts/lib/deduplication.js` (`slugify()`/`normalizeTitle()` silently
dropping a bare "/" instead of treating it as a word separator) and
`scripts/lib/title-match.js` (`VENUE_ALIASES` missing an entry for
"Globe Theatre" ↔ "Shakespeare's Globe").

**How to apply:** before touching `json-write-guard.js`/push infra, run
`gh run list --workflow=update-show-status.yml --limit 5` and read the
"Discover new shows" step's log for the specific show slug. Only chase a
push/merge-race theory if that step's log shows the show was never
discovered fresh (i.e., it truly came from git reconciliation, not
`discover-new-shows.js`).
