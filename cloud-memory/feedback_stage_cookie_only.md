---
name: Stage auth is cookie-only (no email/password login)
description: "THESTAGE_EMAIL/PASSWORD deleted; never re-add login-based auth."
type: feedback
archived: true
---

The Stage (thestage.co.uk) uses cookie-only auth across all scripts. Email/password login was removed entirely on 2026-03-30 after The Stage flagged the subscription for exceeding the 2-device session limit.

**Why:** Each CI workflow created a fresh login session from a different GitHub Actions runner IP. 8+ concurrent sessions triggered The Stage's session limit warning. Cookies reuse existing sessions without creating new ones.

**How to apply:**
- All Stage access goes through `cookie-loader.js` (`loadCookiesForDomain('thestage.co.uk')`)
- Cookies live in COOKIES_BUNDLE secrets (CI) or `data/cookies/thestage.json` (local)
- `THESTAGE_EMAIL` and `THESTAGE_PASSWORD` GitHub secrets have been deleted — do NOT recreate them
- If cookies expire and Stage access breaks, refresh cookies via Safari export — never re-add email/password login
- `scrape-thestage-roundups.js` verifies cookies against a hardcoded roundup URL (`broken-glass-at-the-young-vic`) — if that page is removed, verification will false-negative but won't crash
