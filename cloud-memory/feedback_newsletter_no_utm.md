---
name: feedback_newsletter_no_utm
description: Scorecard Weekly newsletter links have no UTM tags — email-driven site traffic is untrackable in GA/PostHog; General list is only ~328
metadata: 
  node_type: memory
  type: project
  originSessionId: 92c0c27f-40ed-4470-b31d-0d219f6fa42f
---

**UPDATE 2026-05-30 (commit 7e9c11e16d) — UTMs now shipped.** All subscriber emails are UTM-tagged via `scripts/lib/email-utm.js` `applyUtm(html,{source,medium,campaign})`, an idempotent post-processor wired into the 4 generators: `generate.mjs` (source=newsletter, campaign=weekly-<date>), `send-opening-night-broadcast.js` (opening-night), `fantasy-weekly-email.js` (fantasy), `send-btc-results.js` (beat-the-critics). It tags first-party `broadwayscorecard.com` links, skips unsubscribe/`/api/`/external/Resend-token, decodes `&amp;` before parsing, won't double-tag. Independently verified: real newsletter render tags 37/37 first-party links (0 missed, 0 double), URLs resolve 200, 14 unit tests pass. **Filter GA4/PostHog by `utm_source=newsletter` (or fantasy / opening-night / beat-the-critics) to attribute email traffic.** `send-opening-digest.js` is deliberately NOT tagged (internal owner digest).

Historical (pre-fix): the newsletter linked to plain `broadwayscorecard.com/...` URLs with no UTM parameters, so clickthroughs landed as `$direct` and email traffic could not be isolated.

Reach is tiny: Resend **General audience = ~328 contacts** (West End = 12), id `472ec5ef-d7cc-4c48-8007-c0a6a302e7a4`. Even a healthy 5% CTR ≈ ~15-20 clicks — far below the daily floor of 300-600 direct visitors, so a send is invisible in aggregate traffic. Confirmed on the May 25 2026 send ("Celebrity Autobiography opens to decent reviews", 11:05am ET): ~5% sample CTR, no detectable bump in mail-referral / direct / landing-page traffic.

**How to apply:** To make future sends measurable, add `?utm_source=newsletter&utm_medium=email&utm_campaign=...` to links in `generate.mjs`, then filter GA/PostHog by `utm_source=newsletter`. To read per-broadcast open/click rates, use the Resend dashboard — the `/broadcasts` API is hook-blocked (`block-resend-broadcasts.sh`) and `/emails` cursor pagination 403s, so only the most-recent ~100 sends are samplable. Growing the 328-person list is the real lever. See [[feedback_analytics_real_users_lens]] and [[email-broadcast-rules]].
