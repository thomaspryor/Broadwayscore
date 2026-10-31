---
name: feedback_sunset_gate_unknown_date_default
description: "Time-boxed promo/banner gates must default OFF when their keying record is missing, or they resurrect after a season/period rollover"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8897a959-fcae-4e9a-890a-2da4b0dfa448
---

A sunset/expiry gate that returns "active" when its keying record is absent will **resurrect itself** once the keyed period rolls over. On 2026-06-22 the homepage Tony-predictions and Beat-the-Critics promos were live two weeks after the June 7 ceremony — and the user's earlier "remove BTC" request appeared not to stick. Root cause: `isTonyPromoActive`/`isBtcPromoActive` in `src/lib/data-tony-predictions.ts` did `if (!ceremonyDate) return true`. The gate hid correctly right after the ceremony (deadline comparison), but once `getTonySeasonWindow()` advanced to the next season (2026-2027, ceremonyYear 2027) which had **no ceremonyDate record yet**, both gates hit the unknown-date fallback and went active again — still linking to last season's `/tony-awards/predictions/2025-2026` page.

Fix: flip the fallback to inactive and extract a shared pure helper `isPromoActiveForCeremony(ceremonyDate, now, sunsetDays)` (sunsetDays=2 for the Tony promo, 0 for the BTC entry deadline), locked by `tests/unit/promo-sunset-fallback.test.ts`.

**Why:** "unknown → show it" is the wrong default for anything time-boxed. The absence of a date record is not "we're early in a live window" — after a rollover it's "there's nothing current to promote," and the promo's hardcoded URL points at the stale prior period. Same trap as [[feedback_conservative_default_can_be_common_case]]: the conservative-looking default becomes the common case once the period turns over.

**How to apply:** For any banner/promo/shelf gated on a date+window: when the keying record (ceremony date, sale end, event date) is missing/unknown, default the gate to **OFF**, not ON. Verify by simulating the rollover: does the gate hide once the current period's keying record disappears? If the promo hardcodes a period-specific URL, an unknown-period gate must hide it. Test the pure decision with an explicit `undefined` date case asserting `false`.
