---
name: 404 is not always terminal failure
description: For API pollers that reconcile persistent state, never flip a success flag to failure on 404 without a prior-state check. Retention reaps of successful records cause duplicate-action bugs.
type: feedback
originSessionId: 3548d82c-4d8f-4ce3-8b16-044161f84602
---
When an API poller reconciles persistent state (e.g. "was this broadcast sent? was this task processed?") with an external service, an HTTP 404 response does NOT mean "reset back to pending". The resource may have been reaped by normal retention on a successful completion. Without a prior-state check, flipping `completed: true → false` on a 404 causes duplicate-action bugs.

**Why:** Real-world incident on 2026-04-22. `scripts/lib/broadcast-state.js:applyResendStatusUpdate` treated `GET /broadcasts/{id} → 404` as "draft deleted by user, requeue for send". Verified against the live Resend API: `the-balusters-2026` was successfully broadcast on 2026-04-21 (161 subscribers), Resend already 404'd the broadcast id 24h later. The original code would have flipped `completed: false`, and `shouldRequeueShow` would have re-queued the show 12h later → duplicate broadcast to the whole audience. Fixed in commit `b636854001` by differentiating 404 by prior state.

**How to apply:**

Rule for any poller that reconciles API state with a local success flag:

1. **404 is ambiguous.** It can mean (a) resource never existed, (b) pre-completion delete/cancel, or (c) post-completion retention reap. You cannot distinguish (b) from (c) from the 404 alone.
2. **Differentiate by prior state.** If the local record was previously in a success state (e.g. `draftStatus: 'sent'` or legacy `completed: true` without a status field), assume (c) — preserve `completed`. Otherwise assume (b) — flip to requeue.
3. **Never downgrade a success marker on 404 alone.** Explicit API cancellation signals (e.g. `status: 'cancelled'`) are the only thing that should flip `completed: true → false`.

Canonical implementation: `scripts/lib/broadcast-state.js:applyResendStatusUpdate`. Copy that pattern when writing new pollers.

**Sweep findings (2026-04-22):** 17 distinct 404 handlers across `scripts/`. Only `broadcast-state.js` had the retention-reap bug. Others all had correct semantics for their domain:

- Scraping 404 (Wayback, SeatPlan, LTD, LBO, BWW, login pages, review fetch): 404 = no such page, skip. Safe.
- URL link-check 404 (TodayTix, Telecharge, Ticketmaster, review URLs, Playbill Verdict critic URLs): 404 = this URL is genuinely broken, replace/flag. Factual, not a success flip.
- Config-file 404 (gh api for `opening-night-sent.json`, send-lock gist, workflow file): 404 = doesn't exist yet. Safe.
- API error 404 (Formspree poll): returns empty; no state flip. Safe.

**When this rule does NOT apply:** 404 on an outbound fetch where you're gathering data (not reconciling state). Example: scraping a Wayback snapshot, checking if a TodayTix URL is still valid. In those contexts 404 IS the answer, not a state transition.

**Lint-time check:** when you see `if (status === 404)` or `!res.ok` in a script that also manages a `completed`/`sent`/`processed` field, check that the 404 branch doesn't naively flip the flag.
