---
name: reference-paywall-subscriptions-status
description: Which outlet subscriptions the owner pays for vs cancelled (Bloomberg/Telegraph/newspapers.com cancelled July 2026) — check before advising on paywall recovery or prompting re-login
metadata: 
  node_type: memory
  type: reference
  originSessionId: e02aeafc-deda-4880-86b6-03c60e59e534
  modified: 2026-08-02T19:45:10.727Z
---

Owner's paywall subscription status (as of 2026-07-21):

**Cancelled (do NOT prompt to re-login; expect cookies to die and stay dead):**
- Bloomberg — cancelled 2026-07-21. Impact: ~1 theater review/yr (no critic since Jeremy Gerard left 2014; corpus: 40/yr 2010-2013 → 0-3/yr after). Scores for those shows come via aggregators; no free full-text path exists.
- Telegraph — cancelled 2026-07-21. Non-breaking: pipeline fetches full text via Bright Data with no login (45 complete reviews May–Jul 2026).
- newspapers.com — cancelled earlier; access ends 2026-08-27. Was never automatable (viewer blocks all tiers).

**Active + verified working (functional body-length test 2026-07-19/20):**
- WSJ UPDATE 2026-08-02 19:34 UTC: subscription ACTIVE (auto-renews 2026-08-08 at $20/4wk, 50% discount locked for 13 payments per Jul 18 renewal email). Safari LOGIN session lapsed after the 2026-07-20 export. Owner ran `python3 scripts/extract-safari-cookies.py --push` WITHOUT first logging into wsj.com in Safari — the script only harvests whatever cookies already exist in Safari's jar, it does not perform a login. Result: still LOGGED-OUT (body 300 / need 1500). The fix requires the owner to actually open Safari, sign into wsj.com interactively, THEN re-run the extract script — running the script alone accomplishes nothing. NEVER confuse a lapsed login with a cancelled subscription (a session on 2026-08-02 wrongly told the owner WSJ was cancelled by reading only this file's index description).
- WaPo REGRESSION 2026-08-02 19:34 UTC: same verify-cookie-login.js run that reconfirmed WSJ also found washingtonpost.com now LOGGED-OUT (body 400 / need 1500) — previously verified working 2026-07-19/20. Same fix: owner must log into washingtonpost.com in Safari before re-running the extract script.
NYT, WSJ, New Yorker, WaPo, FT, Times UK, The Stage, Variety, Vulture, Standard, Independent — cookies refreshed from owner Safari 2026-07-20, pushed to COOKIES_BUNDLE_1-4 secrets. As of 2026-08-02 the wsj/wapo entries in that list are stale (see regressions above) — nytimes, variety, thestage, newyorker, ft, thetimes still verified logged-in.

**No subscription exists (never prompt for login):**
- Backstage — jar is only a cf_clearance bot cookie; no credentials, no Gmail receipts in 2 years.
- Newsday — not logged in per extractor; content arrives without auth. Task #280 (2026-07-22): "62 reviews in 2026" was a historical-backfill artifact (old 2005-2019 reviews reprocessed Jan-Jun 2026), not new coverage — Newsday's dedicated Broadway reviewing ended ~2019-2021 (2 exceptions in 2025); nothing published Jan-Jul 2026 for our pipeline to miss. Don't reopen as a "discovery gap" without a fresh site:newsday.com "Theater Review" SERP check first.

**How to apply:** before recommending a cookie refresh, subscription, or Browserbase batch against a paywalled outlet, check this list — cancelled/nonexistent subs make those paths permanently dead ([[feedback_cookie_health_body_length_not_expiry]]).
