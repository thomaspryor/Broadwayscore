---
name: Tier-2 year reroute needs same-market gate
description: Year-based sibling reroute (scripts/lib/market-routing.js Tier 2) must require same-market or a Broadway URL marker — ID-year proximity alone misroutes legitimate UK reviews to BW siblings.
type: feedback
originSessionId: 09cffc21-a940-430e-af95-9aaa34b77f2b
archived: true
---
In `scripts/lib/market-routing.js`, Tier 2 (year-level fallback via `pickRerouteTarget`) fires only when the current show has no `openingDate`. Even then, you CANNOT reroute purely on ID-year distance — you must also require:

1. Target sibling is **same market** as current show, OR
2. The incoming URL has a Broadway marker (`isBroadwayUrl()` returns non-null)

**Why:** Many OWE/WE shows have `-YYYY` ID suffixes that reflect the show's creation year, not its production era. Example: `a-dolls-house-off-west-end-2026` has `openingDate: null` (Tier 1 skipped). Its closest-by-ID-year sibling is `a-dolls-house-2023` (BW, distance 1 from 2022 review year). Pre-gate, Tier 2 would reroute 14 legitimate UK 2022 Doll's House reviews to the unrelated Broadway 2023 production.

**How to apply:** When editing Tier 2 logic OR adding a new date/year-based routing rule, ask: "would this fire cross-market purely on proximity?" If yes, add the same-market-or-Broadway-URL gate. Cross-market routing requires an explicit signal (URL path, outlet registry, venue mention), never just date/year closeness.

Tests that cover this: `tests/unit/market-routing.test.mjs` → "does NOT Tier-2 reroute cross-market UK review..." and "DOES Tier-2 reroute cross-market when URL has Broadway marker".

Surfaced during WE #5 work (Notion 34c637c5-416f-81cf, 2026-04-24). Latent bug in `scripts/lib/review-file-writer.js` Guard A — caught by the migration dry-run showing 14 implausible A Doll's House OWE→BW reroutes before I shipped.
