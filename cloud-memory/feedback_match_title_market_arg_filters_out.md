---
name: matchTitleToShow market arg filters candidates OUT, doesn't just bias the pick
description: Passing market: 'broadway' to matchTitleToShow when looking for an off-broadway show silently REMOVES OB candidates from pickBestProduction at scripts/lib/show-matching.js:507-518. The category check downstream then fails and the show is never corrected. Caught 2026-04-29.
type: feedback
originSessionId: beeab90a-2eb2-4817-b850-1b6881564dde
archived: true
---
When calling `matchTitleToShow(title, candidates, { market })` from a market-specific enrichment script, pass the EXACT market the script handles — not 'broadway' as a generic.

`scripts/lib/show-matching.js:507-518` `pickBestProduction` does:
```js
if (preferredMarket === 'broadway') return !cat || cat === 'broadway';
if (isLondonMarket(preferredMarket)) return isLondonMarket(cat);
return cat === preferredMarket;
```

So `market: 'broadway'` filters to `!category || category === 'broadway'` — which **excludes** off-broadway shows (their category is `'off-broadway'`, not nullish). When a title has both Broadway and OB productions, the OB candidate is silently dropped from `matches`, and the pick goes to a Broadway show. Downstream `result.show.category !== 'off-broadway' continue` then skips the show entirely → no date correction happens, no error logged, no audit entry.

**How to apply:**
- Off-Broadway date enrichment: `market: 'off-broadway'`
- Off-West-End: `market: 'off-west-end'`
- Broadway: `market: 'broadway'` (treats null category as Broadway, which is correct for that market only)
- West End / Off-West End: market: 'west-end' or 'off-west-end' (London markets matched together via isLondonMarket)

**Why:** caught 2026-04-29 in `scripts/enrich-off-broadway-dates.js:422` during /ship-check. The bug masquerades as "no date proposed for this show" rather than crashing — code review can't catch it because the call site looks reasonable. Spot-check by running the script with --verify and grepping for shows that SHOULD have proposed changes but don't.

**Detection:** If an enrichment script reports "0 changes" against shows that obviously need correction, suspect this bug first. Verify by temporarily removing the market arg and re-running — if changes appear, market arg was the filter.
