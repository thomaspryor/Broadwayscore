---
name: feedback_llm_v6_late_star_anchor_race
description: WE/OWE reviews scored before a high-reliability star arrives are stuck at unanchored llm-v6 even after the star lands; the rebuild ignored it. Fall through to flat-star + a corpus re-anchor backfill.
metadata:
  node_type: memory
  type: feedback
  originSessionId: 16d96be1-473b-4d44-b95b-e6ffb581510d
---

WE/OWE shows auto-anchor (ANCHORED_MARKETS in `star-reliability.js`): a
high-reliability star → V6 prompt with a band constraint `[floor,ceiling]`.
**`llm-v6` = the unanchored variant** — the show was scored with NO star present
at scoring time. The bug (found 2026-06-29 auditing recent WE opens): when the
star arrives LATER (aggregator publishes stars hours/days after the LLM already
scored the body), nothing re-anchors. The review stays `scoreSource:'llm-v6'`
with a now-present `originalScore`, and its score can sit out-of-band
(e.g. care Time Out body-scored 77, star is 3/5 → band [51,70]).

Two compounding traps:
- **`getBestScore` returned the llm-v6 score unconditionally** at P0.4, never
  looking at the late star. Fix (rebuild-helpers.js P0.4): only short-circuit on
  llm-v6 when there is NO high-reliability late star — else fall through to P0.5
  (flat `originalScore` star). Gate on `originalScoreSource NOT in
  LOW_RELIABILITY_STAR_SOURCES` (a v1 that trusted any numeric star caused 7
  regressions).
- **`isHighReliabilityStar(data)` reads `data.scoreSource`** — which is the stale
  `'llm-v6'`, so it mis-judges late stars. The reanchor helper
  (`scripts/lib/late-star-anchor.js`) must gate on `data.originalScoreSource`
  (the EXTRACTION source) directly, NOT call isHighReliabilityStar.

**How to apply:** a true re-anchor (re-run the V6 prompt with the band) needs a
rescore — `scripts/flag-late-star-reanchor.js` sets `needsRescore=true` +
`rescoreReason='late-star-anchor'` corpus-wide for WE/OWE, then
`llm-ensemble-score.yml --needs-rescore`. The P0.4 flat-star fall-through is the
immediate safety net so a stuck llm-v6 never serves out-of-band before the
rescore lands. After backfilling, RE-AUDIT (`audit-star-accuracy.js`) on fresh
reviews.json — don't assume; a stuck llm-v6 that still shows is usually a
consent-wall stub (no body to anchor) covered by the flat-star fallback. Same
SET-without-re-evaluate smell as [[feedback_stale_wrongproduction_flag_never_recleared]];
band/star-reliability detail in [[feedback_star_score_cap]].
