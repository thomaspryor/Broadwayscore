---
name: feedback_rageclick_session_dedup
description: "Rage-click card \"N clicks on page X\" counts can come from one session hopping pages — query PostHog by session_id before trusting the per-page framing"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 964174e3-5fe4-42c5-b63e-0aaf4447aadc
  modified: 2026-07-21T04:03:58.473Z
---

A rage-click card's per-page click counts (e.g. "4 on page A, 2 on page B, 2 on page C") can be almost entirely one real user's single browsing session, not N independent frustrated visitors. Investigating card #228 ("rage clicks across multiple Off-Broadway show pages"), 8 of 9 flagged `$rageclick` events traced to one Firefox/Brooklyn session (same `$session_id` and `$device_id`) that arrived via the newsletter and browsed all three flagged pages within 7 minutes.

This didn't invalidate the bug (the session's repeated clicks still pointed at a real, confirmed defect — the ticket CTA), but it changes how much evidence backs the "systemic, affects many users" framing a card asserts, and whether the 3-pages/N-users story the acceptance criteria implies is accurate.

**How to apply:** Before accepting a rage-click (or any per-page event-count) card's framing, query PostHog directly:
```
SELECT timestamp, properties.$current_url, properties.$session_id, distinct_id, properties.$device_type
FROM events WHERE event = '$rageclick' AND properties.$current_url LIKE '%...%'
ORDER BY timestamp ASC
```
(`POSTHOG_PERSONAL_API_KEY`, project 332742, per [[feedback_analytics_real_users_lens]]). Group by `session_id`/`distinct_id` — if most events collapse to 1-2 sessions, say so explicitly in the fix's rationale rather than silently treating the raw per-page counts as N independent incidents. Also pull `$active_feature_flags` from the event properties — flags active at click time are a strong corroborating signal for which on-page component was actually being clicked, especially when `$el_text`/`$elements_chain`/`$selector` come back null (autocapture didn't capture element detail on these events).
