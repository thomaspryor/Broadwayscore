---
name: feedback_awards_enrichment_scoring_decoupled
description: Data enriched into awards.json does NOT automatically contribute to award scores — computeSiteAwardScore() is completely decoupled and must be explicitly updated.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b0f88094-bea0-4077-8b88-7d581ce225bc
---

Enriching ceremony data (obie/lortel/criticsCircle) into `awards.json` via `enrich-awards-with-precursors.js` does NOT make those ceremonies contribute to the award score. `computeSiteAwardScore()` in `src/lib/awards-scoring.ts` has an explicit allowlist: it only scores ceremonies that have a `CeremonyKey` entry in the `POINTS` table AND a corresponding `if (entry.X)` block in the function body.

**Why:** The two systems are intentionally decoupled — enrichment populates the `AwardsShowEntry` interface (storage), scoring reads from it selectively (computation). But the decoupling means adding a new ceremony to the data pipeline leaves zero footprint in the scoring engine.

**How to apply:** When integrating a NEW ceremony:
1. Add to `AwardsShowEntry` interface (already done by sprint)
2. Add `CeremonyKey` type union (awards-scoring.ts line 25)
3. Add entry to `POINTS` table (awards-scoring.ts line 37)
4. Add `if (entry.X)` scoring block in `computeSiteAwardScore()` (awards-scoring.ts line ~236)
5. Add to `ceremonies.ts` `OtherAwardKey` and `OTHER_CEREMONY_CONFIGS` for UI display

Missing step 2-4 means data exists but contributes 0 points. Caught by ship-check QA on 2026-05-17 (obie, lortel, criticsCircle were enriched but never scored — 14 shows affected).
