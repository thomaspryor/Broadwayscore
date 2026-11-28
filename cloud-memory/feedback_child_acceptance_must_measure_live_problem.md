---
name: feedback_child_acceptance_must_measure_live_problem
description: "Dispatched-card acceptance commands must count the defect on the LIVE site (core reviews.json), not re-run the fix's own narrowed rule — two children passed their own checks with the problem still live"
metadata:
  node_type: memory
  type: feedback
  originSessionId: a45a81a7-67e7-4ba8-a8f0-9ae05711e280
  modified: 2026-09-30T05:55:14.129Z
---

When writing `## Acceptance criteria` for a dispatched fix card, the command must measure the PROBLEM as the site shows it (read core-data reviews.json / count live rows), not the rule the child writes. On 2026-09-30 (BRO-4148 round 5), BRO-4402 passed `heal-outlet-mismatch.js --dry-run = 0` while 15 NYT reviews were still live as About Entertainment (its rule skipped duplicateOf files), and BRO-4406 passed `audit-cloned-excerpts --live-only = 0` while Time Out was still double-counted (the phantom got its own excerpt, so the pair key no longer matched). Coordinator re-verification against reviews.json caught both → follow-ups BRO-4411/4412.

**Why:** a child's acceptance check shares the child's blind spot; "0 by my rule" is not "0 on the site".
**How to apply:** in every card, name a live-site check (e.g. `audit-publisher-domain-live.js`, per-(show,outlet) live row counts) plus 2-3 named concrete cases to spot-read in reviews.json after landing; when verifying a child, re-run the spot cases yourself, never just its acceptance command. Related: [[feedback_dispatching_session_owns_landing]].
