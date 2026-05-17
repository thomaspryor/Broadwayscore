---
name: WSJ/New Yorker CI IP block
description: WSJ and New Yorker block GitHub Actions datacenter IPs even with valid subscriber cookies — fetchPage() cannot reach them from CI, only Browserbase can.
type: feedback
originSessionId: d554efee-2faa-4e6f-a1ee-aea0f429a0fa
---
Plain-HTTPS and Bright Data both fail for WSJ/New Yorker from GitHub Actions runners even with 50+ fresh subscriber cookies, correct Referer, and Sec-Fetch-* headers. DataDome (WSJ) and Condé Nast (New Yorker) block datacenter IPs regardless of cookie validity.

**Why:** Verified via 4 consecutive CI dispatches of `check-cookie-health.yml` with `live_check=true` on 2026-04-22 (runs 24813150944, 24813220101, 24813334053, 24813441196). WSJ returned HTTP 401; New Yorker returned infinite redirect loop; Bright Data residential proxy returned 0 bytes. Cookies themselves were fresh (djcs_route valid 155d, CN_access valid 155d).

**How to apply:**
- Never try to fetch WSJ or New Yorker content via `fetchPage()` from CI — it won't work regardless of how well the cookies are wired.
- Production WSJ/New Yorker collection path is **Browserbase via `scripts/collect-review-texts.js`** (see `archiveFirstSites` and `brightDataPreferred` lists, plus the Browserbase tier config).
- If a session is debugging "WSJ review missing on opening night," the cookie wiring is NOT the likely cause post-PR #260. Look at: (1) did `collect-review-texts` dispatch same-night, (2) Browserbase session caps (10/run default), (3) WSJ SSO anti-bot fake-reject (`scripts/collect-review-texts.js:264`), (4) Archive.org doesn't cover same-day.
- `scripts/check-cookie-health.js` Layer 3 correctly warns (not fails) for `proxyBlocked: true` outlets when plain-HTTPS + BD both block — it's expected. Layer 1+2 (cookies present, auth not expiring) is the actionable signal.
