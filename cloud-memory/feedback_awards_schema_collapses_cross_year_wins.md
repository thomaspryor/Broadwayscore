---
name: awards-schema-collapses-cross-year-wins
description: "awards.json wins live on one show record tagged with primary tony.season; cross-year ceremony wins (e.g. Hamilton DD 2015 OB on hamilton-2015 season 2015-16) coexist. Cleanup must be per-(winner, Tony-mismap), never per-season-sweep."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 906facf7-a408-4358-bbac-2fc4c57859aa
---

In `data/awards.json`, each show has ONE `<ceremony>.wins[]` list tagged with ONE `<ceremony>.season` value (the show's primary Tony season). But Wikipedia ceremonies recognize productions across multiple seasons — an OB→Broadway transfer can win DD in YEAR-1 ceremony (OB run) AND DD in YEAR ceremony (Broadway run), and both wins live in the same `dramadesk.wins` array on the Broadway-tagged show record.

Example: `hamilton-2015.dramadesk.season = "2015-16"`. Its wins include both DD 2015 (OB year, multiple person-winner attributions via pair-based) and DD 2016 (Broadway). The schema gives you no way to tell which year a given win came from.

**Why:** When fixing `applyDDOCCDL` in `scripts/enrich-awards-with-precursors.js`, the obvious cleanup of "for the current row, strip the category from any other show in the same season" wipes 5+ of Hamilton's legitimate DD 2015 OB wins whenever DD 2016 row processes — because hamilton-2015's `dramadesk.season` matches. The bug only surfaced via ship-check spot-checking Hamilton, otherwise would have shipped silently.

**How to apply:** Any cleanup logic in `applyDDOCCDL` (or future enricher functions) MUST operate per-(winner, specific-Tony-mismap) — i.e. only strip the category from a show if (a) the OLD Tony-only matcher would have credited that specific person to that specific show, AND (b) the NEW pair-based matcher credits that person elsewhere. Never broad-season sweeps; never set-based cleanup that aggregates across tie-winners (a tie with two winners going to two different shows means one winner's correct show may equal another winner's Tony show).

Tests pin this: `tests/unit/awards-person-winner-pairing.test.mjs` "OB→Broadway transfer wins survive cleanup" assertion. See [[scoring-delta-required]] for the standard pre-commit verification, and `scripts/enrich-awards-with-precursors.js:449` for the working implementation.
