---
name: feedback-reddit-app-creation-broken
description: "NEVER ask the user to create a Reddit app (reddit.com/prefs/apps) — broken for their account for months, many sessions have asked repeatedly"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e1dca052-76ad-4dd8-8376-9e6618e9e514
  modified: 2026-07-22T00:40:24.975Z
---

Reddit app creation at reddit.com/prefs/apps does not work for the owner — it has been broken for months and multiple sessions have each independently asked them to create one (owner flagged this 2026-07-21 during Social Pulse v3).

**Why:** Reddit's app-creation flow fails for their account(s); the exact cause is unknown but it is a known persistent issue, not user error. Asking again wastes their time and erodes trust.

**How to apply:** Never ask the owner to mint REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET. The OAuth path in `scripts/lib/reddit-api.js` stays dormant (it activates automatically if credentials ever appear). For Reddit data, rely on: ScrapingBee after its monthly reset (~5th), and the null-counter "signal absent" degradation in the Social Pulse pipeline (Guard 6b publishes with renormalized weights when all Reddit providers are down). Bright Data is robots-gated for reddit.com; ScrapingDog stealth renders unusable `<pre>` bodies; direct requests 403 even from residential IPs. See [[feedback_sb_credit_budget]].
