---
name: feedback_crux_field_data_flushes_faster_than_28d
description: "CrUX field CWV metrics can visibly improve within days of a fix landing, not the full 28-day window — spot-check before assuming a \"stuck\" field regression needs weeks"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 60cf62a7-71c4-4ff1-894d-34cb0635f94f
  modified: 2026-07-24T15:13:31.747Z
---

Card #368 assumed field LCP (CrUX 28-day trailing p75) "cannot clear for weeks regardless of the fix" and built an expiring acknowledgment on that basis. Re-running the Lighthouse/PageSpeed check 3 days after the SSR fix shipped (commit 20315509d, 2026-07-21) showed /west-end's field LCP had already dropped from 2512ms to 2338ms — under the 2500ms Good threshold — well before a 28-day window would fully flush pre-fix sessions.

**Why:** CrUX's rolling p75 isn't "wait N days then it updates" — it shifts incrementally each day as the oldest day's sessions roll off and the newest day's roll in. A high-traffic page with a meaningfully-improved LCP can visibly move the aggregate within days, especially if the fix affects a large fraction of daily sessions.

**How to apply:** When a post-fix field CWV metric looks "stuck," don't assume a fixed wait (28 days) before rechecking — a cheap spot-check (`node scripts/check-seo-health.js` or a manual PageSpeed call) a few days after the fix can already show real movement. Keep any expiring-acknowledgment window ([[project_seo_cwv_field_lcp_grace]]) as a safety net for the slow case, but don't skip an early recheck just because "CrUX is 28-day trailing."
