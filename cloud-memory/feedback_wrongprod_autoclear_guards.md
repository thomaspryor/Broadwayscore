---
name: wrongProduction auto-clear guards
description: "Respect CV and manual reasons; NYT/Variety/TimeOut are NOT UK outlets."
type: feedback
originSessionId: 20ebcdcd-4641-4d32-8342-95738ea48cc1
archived: true
---
The rebuild's wrongProduction auto-clear has four separate paths in scripts/rebuild-all-reviews.js, each with different guards. The hasManualReason guard (added 2026-03-31) was only on the UK-URL path — the allowEarlyDate/allowCrossMarket paths did NOT check it until 2026-04-15. This let cross-market contamination silently re-appear on every rebuild when the flag was set with an audit-derived reason.

**Current state (2026-04-15):**

1. **UK URL auto-clear** (line ~1601) — Has cvConfirmedWrong + cvConfirmedWrongArticle + hasManualReason. ✅ Guarded.
2. **allowEarlyDate/allowCrossMarket wrongProduction** (line ~1611) — Now uses shouldAutoClearWrongProduction from scripts/lib/wrong-production-autoclear.js. ✅ Guarded.
3. **allowEarlyDate/allowCrossMarket wrongShow** (line ~1669) — Now uses shouldAutoClearWrongShow from the same lib. ✅ Guarded.
4. **WE/OB URL-year guard auto-clear** (line ~1462) — Only fires when wrongProductionNote includes "URL contains year". ⚠️ NO hasManualReason check.
5. **wrongShow UK URL on London** (line ~1666) — Has isWrongArticle + wsDateMismatch. ⚠️ NO wrongShowReason check.

**Why:** 2026-04-15 — 5 A_cross_market audit flags set with `wrongProductionReason='cross-market-audit-2026-04-15'` got stripped by path #2 within hours. Fixed in commit 50d811e976 by extracting the decision logic to a testable lib (13 unit tests covering all combinations).

**Pattern to remember:** When flagging a review as wrongProduction/wrongShow:
- ALWAYS set a `wrongProductionReason` or `wrongShowReason` string — this prevents #1-3 from auto-clearing.
- For paths #4 and #5: the reason check isn't present, so current workaround is to avoid triggering those specific conditions. Future hardening tracked at [Notion card P1].

**Pattern when fixing ANY auto-clear bug:** Grep for all writes to the `*AutoCleared` field (e.g. `wrongProductionAutoCleared`, `wrongShowAutoCleared`). Each path is a cousin bug candidate. The same logic should go through one chokepoint — the wrong-production-autoclear lib.
