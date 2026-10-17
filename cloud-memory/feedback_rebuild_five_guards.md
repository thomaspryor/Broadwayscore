---
name: Rebuild has 5 independent wrongProduction guards
description: rebuild-all-reviews.js has 5 separate wrongProduction guards that each need routedFromShowId bypass — patching one misses the others
type: feedback
originSessionId: 12ec4480-78c2-4e18-96dc-3a91403ac6a3
---
Rebuild has FIVE independent wrongProduction guards, not 2-3. When adding a bypass (like routedFromShowId), check ALL of them:

1. **Multi-prod reroute guard** (~line 2098) — `multiProdYearGuard[showId]`
2. **Standalone URL-year guard** (~line 2185) — `!data.publishDate && data.url`
3. **Director cross-check guard** (~line 2217) — `multiProdDirectorGuard[showId]`
4. **Bulk pre-opening date guard** (~line 880) — early block that writes `wrongProduction` to disk
5. **Per-file pre-opening date guard** (~line 1910) — `data.publishDate && showDateMap[showId]`

**Why:** Session patched guards 1-2, ship-check caught guard 3, /what-else caught guards 4-5 (47 false flags). Each guard is independently coded with different bypass conditions — easy to miss one.

**How to apply:** When adding any new bypass condition to wrongProduction logic, grep for ALL guard labels: `grep -n 'wrongProduction\|PRE-OPENING\|DIRECTOR GUARD\|REROUTE\|URL-YEAR' scripts/rebuild-all-reviews.js`
