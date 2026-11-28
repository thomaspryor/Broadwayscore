---
name: shows.json category/market should be set at scheduling time
description: Schmigadoon-2026 had null category/market on opening day; orchestrator logged "default to broadway" warning; should be populated when show first enters shows.json
type: feedback
originSessionId: 059fcd51-c17e-4a91-8e17-cc34bafd046b
---
On 2026-04-20, schmigadoon-2026 had `category: null` and `market: null` in shows.json on opening day. The orchestrator fell back to "default to broadway" — which worked, but the warning is fragile: a future change to orchestrator defaults could silently break discovery. Previously observed on 2026-04-19 per CLAUDE.md Check 5.

**Why:** Categories are discoverable from TodayTix / BWW / basic regex at scheduling time — there's no reason to leave them null through opening day. The null-default path is one more place a production-critical field depends on fallback code.

**How to apply:** Any script that writes a new show to shows.json MUST populate `category`, `market`, `status` (and for Broadway, `isBroadway: true`). Add validation in `validate-data.js` to fail CI if a `status: 'open'` or `status: 'previews'` show has null category or market.

**Still to do:**
1. Audit all entry points that write new shows to shows.json (discover-new-shows.js, update-todaytix.js, manual-add scripts).
2. Add `validate-data.js` guard: `status in {previews,open} && category==null` → fail.
3. Backfill audit: grep all shows with null category/market in current shows.json and correct.
