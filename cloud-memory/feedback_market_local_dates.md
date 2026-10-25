---
name: Market-local dates for show status
description: Show dates (opening/closing) are calendar dates in ET/London — always use getMarketDate() not UTC for comparisons
type: feedback
originSessionId: 1f3d2160-bfda-4bca-8a0f-90c1048cd6f7
---
Show dates (openingDate, closingDate, previewsStartDate) are calendar dates in the show's local timezone: ET for Broadway/OB, London for WE/OWE. **Always use `getMarketDate(category)` from `date-utils.ts` (or inline equivalent in scripts) instead of `new Date().toISOString().slice(0, 10)`.**

**Why:** UTC comparison causes off-by-one: builds running after midnight UTC but before midnight local time (the 5-hour window 8pm–midnight ET) flip shows to wrong status a day early. Titanique (2026-04-12 opening) appeared as "open" at 9pm ET April 11 because UTC was already April 12. This bug was reported by the user multiple times across sessions.

**How to apply:** When comparing any show date (opening, closing, previews) against "today", use market-local time. In `src/`, import `getMarketDate` from `@/lib/date-utils`. In `scripts/`, inline the helper:
```js
function getMarketDate(category) {
  const tz = (category === 'west-end' || category === 'off-west-end')
    ? 'Europe/London' : 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
```
Exception: scripts with fixed-time crons (like `update-show-status.js` at 8 AM UTC = 4 AM ET) where UTC and local always agree.
