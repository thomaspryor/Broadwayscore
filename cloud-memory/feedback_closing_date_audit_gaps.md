---
name: closing-date automation has 4 silent gaps
description: Why 12 wrong closingDate values rotted for weeks despite 2 nominally-automated checks running successfully each cron. Audit only catches LATER-than-stored extensions; silent on every other case.
type: feedback
originSessionId: ba84071c-5a50-4da2-9f43-4971baef697a
---
Both `update-show-status.js` (daily 8 AM UTC) and `check-closing-dates.js` (weekly Mon 10 AM UTC) ran successfully but updated nothing while 12 dates were wrong by 1–223 days. Root cause is structural, not transient.

**Why:** Two scripts plus a third manual enrichment all assume *closingDate only ever moves forward*. They also all rely on sources that are weeks behind the announced final performance.

**How to apply:** When evaluating a date-correctness automation, check four asymmetries before assuming it works:

1. **Monotonic-extension-only logic.** `update-show-status.js:241` updates closingDate iff `ttEndDate > match.closingDate`. `check-closing-dates.js:195` updates iff `scrapedDate > show.closingDate`. Neither flags retractions (Cats Jellicle Ball 9/20 → 9/6) or stale-stored-data (where source agrees with our wrong value).

2. **Source-fidelity gap on TodayTix `endDate`.** TodayTix's `endDate` is the *current on-sale window*, not the announced final performance. Operation Mincemeat announced through 2027-02-14 but TodayTix only sold through ~2026-10-17 — `update-show-status` saw ttEndDate ≈ Oct 17 vs stored 2026-07-05 and… would have flagged but didn't, because TT also matched our stored 7/5 within window. Either way it never sees the real 2/14/2027.

3. **Source-fidelity gap on broadway.org "Through:".** broadway.org `/shows/` lists "Through: <date>" reflecting Broadway League's marketing window, often the same as TodayTix's. Plenty of shows have no Through: at all (open run). 2026-05-11 run logged "Matched 40 of 40 open shows on page" + "0 closing date changes" — the parser worked, the source was just behind.

4. **West End has zero closing-date automation.** Grepped all scripts that assign `.closingDate =` — only `discover-new-shows.js`, `update-show-status.js`, `discover-historical-shows.js`, `enrich-ob-dates-from-showscore.js`, `fix-show-statuses.js`, `enrich-wikipedia-runtimes.js`, `check-closing-dates.js`, `generate-homepage-archive.js`. `enrich-west-end-dates.js` doesn't set closingDate at all. Result: STFS WE went 6/28 → 8/2 (35d off), Avenue Q 8/31 → 8/29, Dracula 5/30 → 5/31, Showstopper 7/31 → 7/27 — all silently stale until manual audit caught them on 2026-05-14.

**Authoritative sources that DO carry the announced final performance** (use these for the rebuilt check):
- Broadway: `broadway.com/shows/{slug}/schedule/` lists every confirmed performance ~5 months ahead. The *latest* date is a lower bound on the announced close. Combine with show-specific press search for the truth past the calendar window.
- West End: `westendtheatre.com/{path}` and the show's official site both carry "until DD Month YYYY" copy that reflects extensions same-day. whatsonstage.com is also reliable but less structured.

**Manual fix log (2026-05-14):** 12 corrections committed via b375c273 (8 BW) + b48cac77 (4 WE). Notion card 360637c5-416f-81f3-bba7-d77cfc7dea6e.

**Don't rebuild atop check-closing-dates.js** — its monotonic-extension assumption is baked into the data flow, not just one regex. Build a new bidirectional audit (`audit-closing-dates.js`) that compares stored vs broadway.com schedule for BW and a WE-specific source for WE, and flags BOTH directions for human review.
