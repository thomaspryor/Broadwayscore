---
name: cookie-health-body-length-not-expiry
description: "Subscription cookies can be present + date-unexpired yet the session is dead server-side; verify logged-in state by extracted review-body length, not cookie expiry"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 052a6222-8014-4e17-bd87-e77b97a81b3f
---

A subscription/paywall cookie being **present and not date-expired does NOT mean
the session works.** Subscription session tokens (Stage `USERSECURE`, NYT, WSJ,
etc.) rotate/die server-side while the cookie's client-side expiry is still
months out. Expiry-date health checks then false-green.

**Why:** 2026-05-29 — The Stage was silently logged out for ~11 days. `data/
cookies/thestage.json` had `USER`/`USERSECURE` with 338 days left, and
`check-cookie-health.js` reported `✅ thestage: Auth OK 338.4d`. But fetching a
review returned a registration wall with 0 extractable body. Re-extracting from
Safari didn't help — Safari itself was logged out, so it just re-grabbed dead
cookies. A single audit across subscription outlets found **4 logged out**
(Stage, WSJ, WaPo, The Times) while NYT/New Yorker/FT/Variety were fine — all
reported "healthy" by the expiry-only check.

**How to apply:**
- The reliable signal is end-to-end: fetch a real review and measure the
  **extracted body length** (`extractArticleTextFromUrl`). Live session +
  working extractor → thousands of chars; dead session (paywall) or truncating
  extractor → a few hundred. This catches BOTH failure modes regardless of cause.
- Run `node scripts/verify-cookie-login.js` to get the logged-in map (free,
  residential IP). It's auto-run at the tail of `extract-safari-cookies.py`.
- The twice-weekly `check-cookie-health.yml` cron now forces `LIVE_CHECK=true`
  and `checkLiveAccess` has a `minBodyChars` floor per outlet (stage 1200,
  variety 1500, nytimes 1500).
- **Fixing a dead session needs the user** — log into the site in Safari (we
  hold the subscription, but Claude can't authenticate it), THEN re-extract +
  push. Re-extracting before re-login is useless.
- Don't conflate this with [[paywalled-star-outlets-not-gaps]]: Stage reviews
  still *score* off star ratings even when the body is paywalled — the body loss
  only costs the excerpt/full-text, not the score. Supersedes the
  cookie-count/expiry confidence in [[Stage cookie minimal set is 5 — don't assume more = better]].
