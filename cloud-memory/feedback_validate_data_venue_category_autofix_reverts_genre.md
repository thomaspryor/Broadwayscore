---
name: feedback_validate_data_venue_category_autofix_reverts_genre
description: "The 'WE category keeps reverting to west-end' mystery: validate-data.js's venue/category cross-check auto-flips off-west-end→west-end for any London show at a West End venue, with no genre awareness. It runs in many CI workflows, so it silently undoes manual recategorizations every run. Fix: genre overrides venue."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2350e148-6bc6-4805-9a87-dddfea2ac7b9
---

If a West End show's `category` won't stay `off-west-end` — you set it, it reverts within hours — the culprit is **`scripts/validate-data.js`'s venue/category cross-check** (the `Cross-checking venue against category` block, ~line 700). It auto-fixes:

- `category === 'off-west-end' && isWestEndVenue(venue)` → `west-end`
- `category === 'west-end' && isOffWestEndVenue(venue)` → `off-west-end`

and writes `shows.json`. `validate-data.js` runs in **many** CI workflows (rebuild, gather, status updates, etc.), so any manual `off-west-end` set on a show at a West-End-listed venue (Sadler's Wells, Peacock, Regent's Park, Garrick — all in `data/west-end-venues.json`) gets reverted on the next CI run. This was the unexplained "category reverted between script runs" in the WE-systemic-fixes handoff §6 that the prior session couldn't reproduce locally (it only fires when validate-data runs, which a quick local edit doesn't trigger).

**Why this matters for genre/dance shows:** dance houses ARE West End venues, so a dance show correctly set to `off-west-end` (per genre policy) was being flipped back to `west-end` every CI run. The data patch looked applied, then silently undid itself.

**The fix (2026-06-29):** genre OVERRIDES venue in that loop. A non-theatrical-genre show (`isNonTheatricalGenre`, see [[feedback_data_propagation_is_automatic_verify_list_pages]] and `src/lib/genre.ts`) is now (a) force-set to `off-west-end` if it's `west-end`, and (b) `continue`'d past the venue flip so it's never reverted. The loop is self-healing instead of self-reverting.

**General lesson:** before assuming a "data edit reverted by a hook/parallel session" is a git/worktree race, grep `validate-data.js` (and other CI-run scripts) for an **auto-fix that writes the same field** — `validate-data.js` auto-fixes category, slugs, status (previews→open), and theaterAddress, each re-reading `shows.json` from disk and writing back. An auto-fix with a rule narrower than your intent will silently undo your edit on every CI run. The fix is to teach the auto-fix about the new signal (here, genre), not to keep re-applying the data patch. Related: [[feedback_data_repos_clobber_uncommitted]] (the other revert class — uncommitted edits clobbered by pull --rebase).
