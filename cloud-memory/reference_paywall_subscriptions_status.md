---
name: reference-paywall-subscriptions-status
description: Which outlet subscriptions the owner pays for vs cancelled (Bloomberg/Telegraph/newspapers.com cancelled July 2026) — check before advising on paywall recovery or prompting re-login
metadata: 
  node_type: memory
  type: reference
  originSessionId: e02aeafc-deda-4880-86b6-03c60e59e534
  modified: 2026-07-22T00:55:36.348Z
---

Owner's paywall subscription status (as of 2026-07-21):

**Cancelled (do NOT prompt to re-login; expect cookies to die and stay dead):**
- Bloomberg — cancelled 2026-07-21. Impact: ~1 theater review/yr (no critic since Jeremy Gerard left 2014; corpus: 40/yr 2010-2013 → 0-3/yr after). Scores for those shows come via aggregators; no free full-text path exists.
- Telegraph — cancelled 2026-07-21. Non-breaking: pipeline fetches full text via Bright Data with no login (45 complete reviews May–Jul 2026).
- newspapers.com — cancelled earlier; access ends 2026-08-27. Was never automatable (viewer blocks all tiers).

**Active + verified working (functional body-length test 2026-07-19/20):**
NYT, WSJ, New Yorker, WaPo, FT, Times UK, The Stage, Variety, Vulture, Standard, Independent — cookies refreshed from owner Safari 2026-07-20, pushed to COOKIES_BUNDLE_1-4 secrets.

**No subscription exists (never prompt for login):**
- Backstage — jar is only a cf_clearance bot cookie; no credentials, no Gmail receipts in 2 years.
- Newsday — not logged in per extractor; content arrives without auth. Task #280 (2026-07-22): "62 reviews in 2026" was a historical-backfill artifact (old 2005-2019 reviews reprocessed Jan-Jun 2026), not new coverage — Newsday's dedicated Broadway reviewing ended ~2019-2021 (2 exceptions in 2025); nothing published Jan-Jul 2026 for our pipeline to miss. Don't reopen as a "discovery gap" without a fresh site:newsday.com "Theater Review" SERP check first.

**How to apply:** before recommending a cookie refresh, subscription, or Browserbase batch against a paywalled outlet, check this list — cancelled/nonexistent subs make those paths permanently dead ([[feedback_cookie_health_body_length_not_expiry]]).
