---
name: Impact subId postback — empirically-verified shape
description: Impact (impact.com affiliate network) accepts subId1/subId2/subId3 query params on click URLs and echoes them back as PascalCase SubId1/SubId2/SubId3 on Action records. URL params are preserved through the OJRQ intermediate hop.
type: reference
originSessionId: 7627197b-724c-4b8d-b25a-cd9400e698ba
archived: true
---
Verified live 2026-04-27 against TodayTix campaign.

**Click URL — append params:**
```
https://{impactDomain}/c/{publisherId}/{campaignId}/{programId}?u={encodedUrl}&subId1={value}&subId2={value}&subId3={value}
```
- camelCase in URL (subId1, not SubId1)
- URL-encode the value if it contains `:` or `,`
- HEAD request returns 302 with `location:` to `https://www.ojrq.net/p/?return=<encoded full URL with subIds preserved>` — confirms Impact accepts the params and preserves them through the tracking hop

**Action API response shape:**
```
GET https://api.impact.com/Mediapartners/{sid}/Actions.json?StartDate=...&EndDate=...
→ { Actions: [ { SubId1: "...", SubId2: "...", SubId3: "...", Amount, Payout, EventDate, ... } ] }
```
- PascalCase in response (SubId1, not subId1)
- Empty string `""` when no subId was sent — not null, not missing
- Values come back URL-decoded (Impact decodes before storing)

**Defensive read:**
```js
const subIdField = (a) => a.SubId2 || a.subId2 || '';
```
Handles both casings just in case Impact ever changes the response shape.

Files: `src/lib/affiliate-utils.ts` (URL builder), `scripts/analyze-ab-test.js` (response reader).
