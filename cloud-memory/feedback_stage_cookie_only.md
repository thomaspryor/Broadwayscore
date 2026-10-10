---
name: Stage auth: cookies in CI, one guarded login on the Mac Studio
description: "Never log into The Stage from CI; only scripts/renew-cookies.js on the Mac Studio may log in (BRO-4183)."
type: feedback
---

The Stage (thestage.co.uk) allows 2 devices per subscription. On 2026-03-30 every CI runner logged in separately, sessions piled up past the limit, and The Stage flagged the account. Email/password login was removed from CI and the `THESTAGE_EMAIL`/`THESTAGE_PASSWORD` GitHub secrets were deleted. Do NOT recreate them.

**Since 2026-09-27 (BRO-4183) the only login path is `scripts/renew-cookies.js --outlet=thestage`, on the Mac Studio, via launchd (`com.broadwayscore.cookie-renew.plist`):**
- It uses one persistent Chrome profile (`~/Library/Application Support/BroadwayScorecard/browser-profiles/thestage`), so it is always the same "device".
- The password comes from the Keychain (service `broadwayscorecard-cookie-renew`, accounts `thestage-email` / `thestage-password`). It never comes from `.env` or GitHub.
- It logs in only when the walled probe (`scripts/lib/cookie-probes.js`) says logged out, and at most once per 20h.
- It stops for a human after 2 logins in 7 days, or on any CAPTCHA, emailed code, or rejected password. Recover with `--manual`, which opens the same profile so you log in by hand without adding a device. Never log in from another browser to fix it, since that adds a session.
- It refuses to run in CI.

**How to apply:**
- CI reads Stage cookies from `COOKIES_BUNDLE_*` through `cookie-loader.js`. Never add a login step to a workflow.
- `data/cookies/_extracted-at.json` stamps `thestage` with `method: "auto-renew"`, and `extract-safari-cookies.py` then skips it, so a Safari run can't push dead Stage cookies. To go back to Safari for Stage, delete that sidecar entry.
- Bundles are pushed only by `extract-safari-cookies.py`. The renewer calls `--from-local --push`; it never writes secrets itself.
- The old probe URL (2023 A Doll's House review) serves its full text anonymously. Any probe must fail with zero cookies (`classifyWalledProbe` reports `vacuous` otherwise).
- The Stage's star rating is on the wall page even when logged out (`extractUKStarRating`); only full text needs the login.
