---
name: feedback_actionable_only_email_alerts
description: Email alerts are for ACTION only — severity critical/error may email; warning/info never email (enforced inside sendEmailAlert). Owner explicitly requested after 305-alert inbox
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 01818bd9-0b9c-4e6d-a366-7b1512af86c3
---

**What the user said (2026-07-11, with inbox screenshot: 305 automated alerts):** "Do you really need all these alerts? They stress me out. I only want ones that I need to action."

**Why:** warning/info emails (WE review gaps, opening-night drop warnings, orphan-unscored, regional auto-adds, broadcast-blocked storms — 17 for one condition) buried the genuinely actionable pages and stressed the owner. FYI-level signal belongs in run logs, step summaries, and the BSC Daily digest (whose repeat-failure promotion catches systemic issues).

**How to apply:**
- The policy is ENFORCED in `scripts/lib/discord-notify.js` (`shouldEmailAlert`, gated inside `sendEmailAlert` so direct callers can't bypass; tested in tests/unit/alert-email-policy.test.mjs). Don't work around it with raw Resend calls for FYI content — if something truly needs to page, set severity `error`/`critical` and be ready to defend that it's actionable.
- When adding a new alert, default to `severity: 'warning'` + no expectation of email. Ask: "would the owner need to DO something within hours?" Only then error/critical.
- A blocked opening-night broadcast IS actionable (upgraded to error 2026-07-11). A review-count FYI is not.
- Policy suppression logs `[Alert policy] email suppressed` and appends to GITHUB_STEP_SUMMARY — it is deliberately NOT the `alert delivery FAILED` ::error:: path.
- The same taste applies beyond email: prefer fixing failure storms over adding alerting for them (the 07-04→07-10 storm was ~180 GitHub failure emails from 5 broken workflows).

Related: [[email-broadcast-rules]], [[feedback_broadcast_quality_bar]]
