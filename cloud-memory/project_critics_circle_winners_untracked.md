---
name: project-critics-circle-winners-untracked
description: "Critics' Circle Theatre Award winners — FIXED 2026-05-20 via custom parser"
metadata: 
  node_type: memory
  type: project
  originSessionId: debb8eb7-7e83-42ff-9561-f280aa67e990
  archived: true
---

**RESOLVED 2026-05-20** — commit `5e10fc8e46` fixed this via a custom `scripts/lib/critics-circle-parser.js`.

Critics' Circle Theatre Awards (`data/precursors/critics-circle.json`) previously had `winner: null` for all entries because Wikipedia's Critics' Circle pages list one winner per year per category in a plain-list format — no row highlighting. The standard `scripts/lib/precursor-category-parser.js` uses background-color detection, which doesn't work for plain lists.

**Fix:** A custom parser was written (`scripts/lib/critics-circle-parser.js`) that treats each row as a winner rather than relying on background-color detection. After re-running enrichment (`scripts/enrich-awards-with-precursors.js`), 22 WE shows now have Critics' Circle wins recorded in `awards.json`.

**Scoring impact:** `computeSiteAwardScore()` in `src/lib/awards-scoring.ts` awards points for `criticsCircle` wins (`criticsCircle.win`). These 22 shows now receive that scoring benefit.

Related: [[awards-enrichment-scoring-decoupled]]
