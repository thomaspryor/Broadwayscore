---
name: Live-API contract test before shipping external integrations
description: Rule — unit tests on mocked API responses cannot reveal empirical API behavior like retention, 404-semantics, or rate-limit shape. Always call the live API with a representative fixture before claiming an integration is shipped.
type: feedback
originSessionId: 3548d82c-4d8f-4ce3-8b16-044161f84602
---
Unit tests that feed a hand-rolled response object to your handler cannot catch bugs whose only source of truth is the external API's actual behavior. Before claiming an API integration is done, call the live API with a representative fixture and observe what it returns.

**Why:** 2026-04-22, I shipped `scripts/reconcile-broadcast-state.js` with 22 unit tests all green — and claimed it was tested fully. The user pushed back with "did you actually test it?" I ran the live API against a real draftId (`the-balusters-2026`, broadcast cleanly the prior night). Resend returned **404**, not `{status: 'sent'}` as I'd assumed. Resend reaps successful broadcasts on normal retention within hours — a behavior no unit test mock can predict because it's empirical, not documented. My original code would have flipped `completed: false` on the 404 and duplicate-broadcast the show 12h later. Fixed in `b636854001` with prior-state differentiation.

**How to apply:**

For any new integration with an external API where you're polling or reconciling state:

1. Before committing, write a standalone `node -e` script that calls the live API with a real record id. Observe:
   - What does the API return for a record you know succeeded?
   - What does it return for a record you know was deleted/cancelled?
   - What does it return after 1h? 24h? 7 days?
2. Confirm your handler's decision tree actually matches what the API does in practice, not what your mental model says it should do.
3. Prefer APIs with documented state-transition contracts (Stripe, Resend) — but even documented contracts omit retention/reap details. Observed behavior beats documented behavior every time.
4. Codify the live-test as a scheduled integration job (see Notion card 34b637c5-416f-819c for the Resend version) so the contract stays verified.

**Red flags to catch in your own claims:**
- "26 unit tests all green, shipping." → Did you call the live API once?
- "The mock returns `{status:'sent'}` on success." → Does the real API ever return something else AFTER success? (Yes: Resend → 404 on retention.)
- "Tested fully." → Unit-tested fully. External contract? Unverified.

**Sibling rule:** `feedback_real_html_integration_test.md` is the parser/scraper version of the same principle. Synthetic fixtures don't catch empirical behavior.
