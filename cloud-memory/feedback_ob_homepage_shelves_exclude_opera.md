---
name: feedback_ob_homepage_shelves_exclude_opera
description: "New homepage/Off-Broadway shelves must filter type!=='opera' — getOffBroadwayShows() returns opera-typed shows that don't belong in OB shelves"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8897a959-fcae-4e9a-890a-2da4b0dfa448
---

Any new homepage or Off-Broadway shelf that pulls from `getOffBroadwayShows()` (`src/lib/data-core.ts`) must add a `type !== 'opera'` filter. That helper scopes only by `category === 'off-broadway'`, and a large block of opera productions (La Bohème, Aida, Così fan tutte, Jenůfa, …) carry `category: 'off-broadway'` with `type: 'opera'` — so they silently flood any unfiltered OB shelf. A 2026-06-25 "Starting Soon" OB shelf shipped ~40% opera (16 of 39 cards) before ship-check caught it.

The convention already exists: `isHomepageNotable()` in `src/lib/homepage-notability.ts` does `if (s.type === 'opera') return false` ("opera has its own shelf / treatment"). The Broadway equivalent shelves don't need the guard because opera is its own *category* and `getBroadwayShows()` already excludes it — the asymmetry is purely on the OB side, which is the easy thing to forget.

**Why:** opera has dedicated surfacing (the "At the Met" homepage shelf / `/opera`); mixing 16 Met-style operas into an Off-Broadway plays-and-musicals shelf is both wrong-feeling and inconsistent with the Broadway shelf it mirrors.

**How to apply:** when building or reviewing an OB/homepage shelf, grep the data first — `node -e "...filter(category==='off-broadway' && status===X)..."` and group by `type`. If opera appears, add `s.type !== 'opera'` to match `isHomepageNotable`. Reuse the existing convention rather than inventing a new exclusion. Related: this rode in with the start-date badge + clickable-shelf-title work.
