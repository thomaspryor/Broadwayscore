---
name: feedback_plays_to_see_dual_market
description: "Plays To See is a noisy dual-market outlet — isDualMarket:true is correct, but its Broadway reviews need wrongProduction vigilance (57% historical misattribution)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f59b0c83-792f-4571-ac93-95f59e04b229
---

`plays-to-see` (playstosee.com, tier 3 London) was `region:london` with no `isDualMarket` flag, so `validate-data.js`'s reverse cross-market check (London outlet on a Broadway show → hard error, scripts/validate-data.js:4090-4103) errored on 3 reviews and turned CI red (2026-06-15): `oslo-2017`, `the-father-2016`, `long-days-journey-into-night-2016`. Those 3 are GENUINE Broadway coverage — the review text names the Vivian Beaumont/Lincoln Center (Oslo) and references the Broadway season — NOT London-production misattributions. Fixed by setting `isDualMarket:true` in `outlet-registry.json` (BOTH repos — dual-repo, [[feedback_outlet_registry_dual_repo]]).

**Why isDualMarket and not a per-review allowlist:** a London paper that legitimately reviews Broadway IS dual-market, same definition as the 15 existing entries (guardian, financialtimes, telegraph). The grain matches design intent.

**The trade-off (ship-check / Codex 2026-06-15, HIGH):** Plays To See is a NOISY dual-market outlet. Of its 8 corpus files, 3 are legit Broadway, **4 are wrongProduction misattributions** (hughie-2016, les-liaisons-dangereuses-2016, touch-2026, touch-off-broadway-2026), 1 West End. The dual-market exemption removes the cross-market validator as an early-warning net for FUTURE PTS-on-Broadway misattributions. That's acceptable because:
- The 4 historical misattributions are all already `wrongProduction:true` → excluded from reviews.json → never reached the validator anyway. The validator only ever errored on the 3 legit ones (false positives by construction).
- `wrongProduction` classification ([[feedback_llm_wrongprod_false_positives]]) is the PRIMARY misattribution filter and caught all 4. The cross-market check can't distinguish legit from misattributed for ANY dual-market outlet — that's inherent, accepted for all 15.
- Tier 3 = 0.35 weight, small score impact if one slips.

**How to apply / watch:** If a NEW Plays To See review lands on a Broadway show, eyeball whether it's the Broadway production (it misattributes ~57% of the time historically). If unflagged PTS Broadway misattributions start slipping into scores, the escalation is a per-(showId×outletId) allowlist in the reverse cross-market check (revert isDualMarket, keep region:london) — more precise grain, more maintenance. Don't do that pre-emptively; the wrongProduction backstop is working.

**Guard added 2026-06-15 (`scripts/lib/cross-market-guard.js` `classifyReverseCrossMarket`):** the reverse cross-market check in `validate-data.js` no longer hard-errors on ANY London-region non-isDualMarket outlet on Broadway. It now splits by tier: **Tier 1/2** London paper on Broadway → hard error (Evening Standard/Times UK never legitimately cover it = genuine contamination); **Tier 3/untiered** London outlet on Broadway → advisory warning + isDualMarket candidate (NOT build-blocking — this is the plays-to-see / The Arts Desk class). Off-Broadway stays a tolerated warning. So the next plays-to-see-style outlet that starts covering Broadway surfaces as a warning to triage into isDualMarket, instead of reactively reding CI. Per-outlet accumulation tracked in `data/audit/london-only-nyc-accumulation.json` (currently only The Arts Desk ×1 off-Broadway). **Alias-casing gotcha found in ship-check:** every alias-keyed map in `validateCrossMarketContamination` (dualMarket, tier12Outlets, outletTierMap, canonicalOutletId, outletRegionMap) MUST `.toLowerCase()` alias keys because lookup uses `oid=(outletId||outlet).toLowerCase()`; `outletRegionMap` was the lone exception, which silently disabled the Tier 1/2 error path for uppercase aliases ('The Times','FT').
