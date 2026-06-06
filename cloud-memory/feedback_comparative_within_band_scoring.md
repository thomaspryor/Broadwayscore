---
name: feedback_comparative_within_band_scoring
description: Anchored-v6 star scoring collapses same-band raves to the q3 anchor (5★→97); re-score a show's same-band reviews comparatively to spread by real warmth. WE/OWE only.
metadata:
  type: feedback
---

When a critic gives an explicit star rating, the anchored path (`scoreSource: 'anchored-v6'`, West End / Off-West-End only) scores each review **in isolation** inside its star band — 5★ → [91,100]. `buildAnchoredBandBlock` (scripts/llm-scoring/config.ts) builds discrete within-band anchors (floor / lower-mid / **upper-mid q3≈97** / ceiling), and "standard rave with a minor qualification" describes almost every 5★ review, so all three ensemble models reach for 97 and the average collapses there. War Horse WE 2026 showed **97/97/97/97** across four 5★ raves whose prose warmth genuinely differs; the corpus 5★ band spiked at 96–97 (72×97, 50×96 vs 8×100). It looked artificial because it *was* under-differentiated, not because the band design is wrong (a synthetic rapturous 5★ scores 100, a measured one 91 — the mechanism works at the extremes; it under-resolves the middle).

**Why:** the LLM can't reliably pick 92 vs 97 for one review in isolation, but it CAN rank reviews against each other. Validated 2026-06-05: scored COMPARATIVELY (a show's same-band reviews in one prompt, ranked by relative warmth), GPT-4o and Gemini both spread War Horse's four 5★ 92–99 **and agreed on the ordering** (Arts Desk coolest, Time Out/FT warmest). The warmth signal is real and detectable — isolation is what flattens it.

**How to apply:**
- Fix lives in `scripts/lib/comparative-band.js` (pure: `buildComparativeBandPrompt` + `parseComparativeResponse` + `combineComparative`) and `scripts/llm-scoring/comparative-rescore.ts` (per-show orchestration: groups anchored-v6 reviews by band, re-scores 2+ groups across available models). Re-exported from config.ts. See [[feedback_scoring_delta_required.md]].
- **Guardrail (do NOT skip):** spread by GENUINE warmth only. `combineComparative` measures cross-model ordering agreement; if two models disagree on the order (no real signal), it keeps the isolated scores rather than invent spread. Distinctness is a soft goal; real warmth is the hard one.
- **Bucket-preserving clamp:** comparative repositions only WITHIN the bucket the isolated score was in (5★ band ⊂ Rave, so 5★ never leaves Rave; the 4★ band [71,90] straddles Positive/Rave so the clamp keeps it in-bucket). Makes the §13 A/B bucket-shift gate structurally 0%.
- Skips human-reviewed files (`humanReviewScore`, `humanReviewedWrongProduction`, etc.) — rebuild precedence P0.4 at rebuild-helpers.js:381 reads `llmScore.score` for anchored-v6, but humanReviewScore (P0) still overrides.
- Run: `tsx scripts/llm-scoring/comparative-rescore.ts --all-we [--dry-run]`. Needs ≥2 of OPENAI/GEMINI/ANTHROPIC keys. `--dry-run` prints the §13 A/B (bucket-shift / mean-drift). First live run (2026-06-05): 483 WE reviews rescored, bucket-shift 0.0%, mean-drift 0.66pt, 5★ spike flattened (97: 72→33; 100: 8→23). War Horse 5★ → 93/97/98/99.
- WE/OWE only for now — Broadway hasn't been migrated to anchored bands (`ANCHORED_MARKETS` in src/config/scoring.ts; `shouldUseAnchoredMode` in scripts/lib/star-reliability.js).
- Known follow-up: Arts Desk on War Horse is duplicated (`artsdesk--unknown.json` anchored-v6 vs `artsdesk--rachel-halliburton.json` llm-v6 = same review) — dedup via duplicateOf.
