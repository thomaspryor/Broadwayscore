---
name: WSJ/New Yorker CI IP block
description: WSJ and New Yorker block GitHub Actions datacenter IPs even with valid subscriber cookies — fetchPage() cannot reach them from CI, only Browserbase can. Plus (task #779): WSJ password-login fake-reject is bypassed via email OTP; even authenticated, SSR JSON stays paywall-locked — only client-hydrated DOM has real text.
type: feedback
originSessionId: d554efee-2faa-4e6f-a1ee-aea0f429a0fa
modified: 2026-08-02T22:08:48.976Z
---
Plain-HTTPS and Bright Data both fail for WSJ/New Yorker from GitHub Actions runners even with 50+ fresh subscriber cookies, correct Referer, and Sec-Fetch-* headers. DataDome (WSJ) and Condé Nast (New Yorker) block datacenter IPs regardless of cookie validity.

**Why:** Verified via 4 consecutive CI dispatches of `check-cookie-health.yml` with `live_check=true` on 2026-04-22 (runs 24813150944, 24813220101, 24813334053, 24813441196). WSJ returned HTTP 401; New Yorker returned infinite redirect loop; Bright Data residential proxy returned 0 bytes. Cookies themselves were fresh (djcs_route valid 155d, CN_access valid 155d).

**How to apply:**
- Never try to fetch WSJ or New Yorker content via `fetchPage()` from CI — it won't work regardless of how well the cookies are wired.
- Production WSJ/New Yorker collection path is **Browserbase via `scripts/collect-review-texts.js`** (see `archiveFirstSites` and `brightDataPreferred` lists, plus the Browserbase tier config).
- If a session is debugging "WSJ review missing on opening night," the cookie wiring is NOT the likely cause post-PR #260. Look at: (1) did `collect-review-texts` dispatch same-night, (2) Browserbase session caps (10/run default), (3) WSJ SSO anti-bot fake-reject, (4) Archive.org doesn't cover same-day.
- `scripts/check-cookie-health.js` Layer 3 correctly warns (not fails) for `proxyBlocked: true` outlets when plain-HTTPS + BD both block — it's expected. Layer 1+2 (cookies present, auth not expiring) is the actionable signal.

**Task #779 addendum (2026-08-02) — Tahoe broke Safari cookie extraction entirely, forced a full pipeline rebuild:**
- macOS Tahoe no longer persists httpOnly cookies to Safari's `Cookies.binarycookies` — confirmed universal across ALL `extract-safari-cookies.py` DOMAIN_GROUPS (~30 outlets), not WSJ-specific. Any outlet still depending on Safari-cookie extraction is silently dead on this machine.
- The "WSJ SSO anti-bot fake-reject" cited above (rejects a *correct* password from any automated-looking browser context) is bypassed by **email OTP** — it sidesteps the password check entirely. `scripts/wsj-otp-login.js` is the reference implementation: real Chrome (`channel:'chrome'`, `launchPersistentContext`, `headless:false`) + Gmail IMAP poll via `~/.claude/bin/gmail` with a server-side `after:<epoch>` cutoff (critical — WSJ's OTP backend can resend the SAME code on a second request, so a naive "check for any recent code" can false-succeed on a stale code).
- Separately: even with a genuinely authenticated REAL browser, WSJ's SSR `__NEXT_DATA__.props.pageProps.isServerUnlockedContent` stays `false` for an active subscriber — the paywall only unlocks client-side. Full text is only in the live DOM (`document.querySelector('article').innerText`) after hydration settles (~1.8s). Any script reading the SSR JSON (like the old `recover-wsj-subscriber.js`) will report paywall-locked even on a working subscription. `scripts/recover-wsj-browser.js` reads the DOM instead.
- Bundled/headless Chromium (not real Chrome) gets served a stripped page by WSJ even with valid cookies loaded via `context.addCookies()` — same class as task #712's Cloudflare-challenge-as-success bug. Real Chrome via `channel:'chrome'` is required, not just `headless:false` on bundled Chromium.
- NYT and New Yorker are NOT yet fixed — same Tahoe root cause applies, OTP/magic-link availability unconfirmed. See card #831.
