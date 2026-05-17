---
name: Stage cookie minimal set is 5 — don't assume more = better
description: "5 cookies (VISITOR, USER, USERSECURE, AWSALB, AWSALBCORS); verify live."
type: feedback
originSessionId: 856d369e-bd09-476d-abdf-06e8655672b3
---
**Rule:** When setting `minCookies` thresholds in `scripts/check-cookie-health.js` for an outlet, verify the actual minimum by fetching a known-protected URL with the bundle and checking for logged-in markers (e.g., "my account" in nav, no "sign in" links). Don't guess based on "most bundles have 20+ cookies."

**Why:** I set thestage `minCookies: 10` based on the assumption that paywalled outlets need many cookies. Wrong — Stage's complete logged-in cookie set is 5: `VISITOR` (tracking), `USER` (subscriber ID, 387-day expiry), `USERSECURE` (auth token), `AWSALB`, `AWSALBCORS` (load balancer). Verified by fetching `thestage.co.uk/` with the bundle and getting back nav containing "my account" + zero "sign in" markers. The wrong threshold caused `check-cookie-health.js` to report Stage as failing for 30+ minutes after a successful refresh, misleading me into thinking the user wasn't logged in. Cost: ~10 minutes of debugging. Fix: minCookies 10→3, authCookies ['USERSECURE', 'USER'] for proper expiry tracking. Commit fb6c752f29.

**How to apply:** For any new outlet added to `CRITICAL_OUTLETS`:
1. Refresh cookies in Safari for that outlet
2. Run `python3 scripts/extract-safari-cookies.py --push`
3. Note the cookie count from the output
4. Build a cookie header from the bundle and curl the outlet's homepage with `User-Agent: Safari/605.1.15`
5. Check the response HTML for logged-in markers ("my account", subscriber name, no "sign in")
6. If logged in: set `minCookies` to the actual count (or count - 2 for slack), and identify the auth cookie name (often has "AUTH", "SECURE", "TOKEN", "session" in it) for `authCookies`
7. NEVER set minCookies based on what other outlets have

Related: feedback_stage_cookie_only.md (Stage auth is cookie-only — never re-add login code).
