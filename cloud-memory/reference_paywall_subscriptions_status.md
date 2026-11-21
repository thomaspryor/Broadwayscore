---
name: reference-paywall-subscriptions-status
description: "Which outlet subscriptions the owner pays for (cost, renewal, login renewal mode) vs cancelled/free, as of 2026-11-14 — check before advising on paywall recovery, cookie re-login, or subscriptions"
metadata:
  node_type: memory
  type: reference
  originSessionId: 12bb3cbc-3123-4956-9529-0ead7b07d820
  modified: 2026-11-15T21:12:08.982Z
---

Full reference page (owner-facing): https://claude.ai/artifact/XhHVYcn6LAAHTWZdDTWJiQ (file `~/Documents/claude-outputs/outlet-subscriptions-2026-11-14.html`). Sources: Gmail billing emails ("[Google Mail]/All Mail" folder, UK account), `data/cookies/*.json` auth-cookie expiry, last-365d review counts from broadway-review-texts.

**Active (2026-11-14):**
- NYT All Access $30.57/mo (owner asked for retention rate 11-08). Manual Safari login, auth cookie NYT-S ~1yr.
- The Stage £7.99/mo, renews 15th. AUTO: launchd `com.broadwayscore.cookie-renew` every 6h (`renew-cookies.js --outlet=thestage`).
- WSJ Digital $20/4wk, renews 11-28; moving to "Digital Package" $10.75 at term end. AUTO: launchd `com.broadwayscore.wsj-cookie-refresh` monthly OTP.
- Telegraph All Access $34.99/mo, free month from 11-11, first charge 12-11. Owner chose to KEEP. Manual-only (`renew-cookies.js --outlet=telegraph --manual`; `--probe-only` to test).
- WaPo Core $14/4wk. Manual; auth cookie wp_ak_signinv2 short-lived (expired 11-16 at time of writing).
- The Times UK ≈£31/mo (intro £1 ended; owner asked for better rate 11-08, told to phone). Manual; authId ~weeks. Owner decided 2026-11-15: KEEP (don't re-ask).
- FT Standard $45/mo, downgraded from Premium 11-14. Manual; FTSession_s ~2mo. Owner decided 2026-11-15: KEEP (don't re-ask).
- New Yorker: login works, no bill in Gmail (likely print/bundle). Manual; CN_access ~2mo.

**Cancelled:** Bloomberg (2026-07/08, ~1 theatre review/yr), newspapers.com (ended 2026-08-28). Telegraph was cancelled in July then re-subscribed 11-11.

**Free / never subscribe:** Guardian, Variety, Vulture, Evening Standard, Independent, Backstage, Newsday.

**Gotchas:** Stage verifier once probed a non-walled article (vacuous pass); WSJ paywall is CSS-side so provider fallback never yields full text, only a real cookie-plain fetch does. Refresh after any manual Safari login: `python3 scripts/extract-safari-cookies.py --push`.

**How to apply:** before recommending a re-login, subscription or Browserbase batch, check this list; cancelled subs mean dead cookies are expected ([[feedback_cookie_health_body_length_not_expiry]]).
