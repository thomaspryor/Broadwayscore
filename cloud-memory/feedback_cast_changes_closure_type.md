---
name: cast-changes-closure-type
description: "Show closures must be modeled as a top-level 'closure' event, not as N per-actor 'departure' events"
archived: true
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8d48a34b-131b-4ee0-b1fe-d7c46a3fb19d
---

When a Broadway production closes, the scraper used to emit one `departure` event per principal actor with a note "Production closes …". The downstream newsletter / cast-updates UI then rendered each cast member as "Nicholas Christopher departs" — which reads as a personal exit, not a show closure. Fixed 2026-05-23: added a first-class `closure` CastEvent type (data-types.ts, cast-changes-filters.js+ts, scrape-cast-changes.js LLM prompt) that renders as a single "Show closes <date>" row and suppresses any per-actor departures sharing the closure date.

**Why:** The Chess case proved the data was also load-bearing on accuracy, not just presentation — a "Production closes June 14" scrape contradicted a separately-captured "JoJo arrives June 23 through Sept 13" entry. Without a closure-vs-arrival cross-check, the closure data won and the production looked like it was closing when it isn't. `scripts/lib/cast-changes-filters.js` `detectContradictions()` now catches this; `scripts/audit-cast-changes.js --strict` runs in test.yml.

**How to apply:**
- New cast-change ingestion paths MUST distinguish show-wide closure from per-actor departure. Reuse the `closure` CastEvent.type, not synthesized departures.
- Any consumer of `data/cast-changes.json` should call `applyPublicFilters()` from `src/lib/cast-changes-filters.ts` (web) or `scripts/lib/cast-changes-filters.js` (Node). Don't re-implement the dedup/staleness/reconcile rules.
- If you add a new cast-change schema field, mirror it in BOTH the .js (CJS) and .ts (ESM) filter modules — they must stay in lockstep.
- Stale [AUTO-FLAGGED] entries (>30d old) are dropped by `audit-cast-changes.js`; don't reintroduce them as a separate "needs verify" UI surface — they were producing 338+ phantom cast events.
- Related: [[review-recovery-pipeline-gaps]] (silent data pipeline failures), [[protected-fields-every-write]] (same write-vs-display contract pattern).
