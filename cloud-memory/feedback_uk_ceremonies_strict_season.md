---
name: uk-ceremonies-strict-season
description: UK ceremonies in enrich-awards-with-precursors.js must set opts.strictSeason to prevent cross-production attribution to Broadway transfers.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8debe801-af8a-4b99-88e2-4398b678f90d
---

When adding a new UK ceremony (CC, ES, WOS, future UK Theatre/Offies/etc.) to `scripts/enrich-awards-with-precursors.js`, it MUST be added to the `UK_CEREMONIES` set in `applyDDOCCDL` so that `strictSeason: true` is passed in `callOpts`. Without this, Pass 1/2's cross-season fallback (`p1FallbackId` / `p2FallbackId`) will silently attribute wins to a Broadway transfer in a different Tony season than the ceremony actually recognized.

**Why:** Bug shipped 2026-05-23 when WhatsOnStage 2024 Best New Musical win for Operation Mincemeat (WE production, season 2023-24) was landing on `operation-mincemeat-2025` (Broadway transfer, season 2024-25). Pass 1's same-title fallback returned the BW production when no same-season match existed. Codex ship-check caught it. Fix in commit 4d38e3a922.

**How to apply:** Two places in `scripts/enrich-awards-with-precursors.js`:
1. `findShowIdByTitle` — Pass 1 + Pass 2 fallback returns gated on `!opts.strictSeason`
2. `applyDDOCCDL` — `UK_CEREMONIES = new Set(['criticsCircle', 'eveningStandard', 'whatsOnStage', 'olivier'])` + `strictSeason = UK_CEREMONIES.has(fieldKey)`

Olivier is included but unused (separate enrichment script) — kept for refactor-resilience.

**Side-effect:** Coverage drops (WOS 512→45, CC 34→6, ES 27→5) because legitimate WE attributions where the WE production isn't in `shows.json` go unmatched instead of cross-attributed to BW. This is the correct tradeoff — bad attribution is worse than no attribution. The lost coverage will recover as WE/OWE `shows.json` backfill happens.

Related: [[silent-merge-loss-on-reformat]] for the data integrity pattern; [[aggregator-pages-post-opening]] for the WE catalog gap that limits Pass 5 matching.

**Critical companion gotcha:** [[awards-json-dual-repo]] — enrich-awards-with-precursors.js writes awards.json to BOTH the public repo (`data/awards.json`) AND the private repo (`~/broadway-scorecard-data/awards.json`). Vercel deploys pull from the PRIVATE repo via `.github/actions/checkout-core-data`. Pushing the public repo alone is insufficient: production renders from private-repo data. After running enrich locally, ALWAYS `cd ~/broadway-scorecard-data && git add awards.json && git commit && git push` too. Confirmed 2026-05-23: WOS chip didn't render on prod for 90+ min until the private repo was pushed.
