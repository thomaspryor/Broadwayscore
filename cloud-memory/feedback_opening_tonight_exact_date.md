---
name: Opening tonight = openingDate === today (exact match only)
description: When asked "what's opening tonight" never widen to multi-day windows; filter shows.json by openingDate === today's NYC date
type: feedback
originSessionId: c465b526-2fc2-4dbe-8cbc-4d7c6db5d9fe
archived: true
---
When identifying "the show opening tonight," filter `shows.json` by **exact** `openingDate === today` in NYC local date — never by a window like "today through tomorrow" or "next 48h."

**Why:** On 2026-04-22 I filtered with `openingDate >= today && openingDate <= '2026-04-23'` and latched onto Rocky Horror (2026-04-23). The user corrected: Beaches was the actual opening (2026-04-22). I fixed category=null on Rocky Horror first — defensive for the NEXT night but not the urgent show. Wasted ~5 min of real-HTML verification effort on the wrong show before the user had to intervene.

**How to apply:**
- `const today = new Date().toISOString().slice(0,10)` in UTC is fine for the 9 PM ET window (01:00 UTC next day) — but verify openingDate equals the NYC calendar date, not UTC.
- Run `node -e "const s=require('./data/shows.json').shows; console.log(s.filter(x => x.openingDate === 'YYYY-MM-DD' && (x.category === 'broadway' || x.category === 'west-end' || !x.category)).map(x=>({id:x.id,cat:x.category})))"` — narrow to broadway/west-end (off-broadway is not "opening night" for readiness purposes).
- If >1 match, ask the user. Don't guess.
- Rocky Horror's fix was still valid defensive work for 2026-04-23; not a wasted commit, but it wasn't tonight's urgent fix.
