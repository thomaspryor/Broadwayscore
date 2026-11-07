---
name: feedback_second_opinion_tmp_collision
description: "/second-opinion writes its plan to a fixed shared /tmp/check-plan.txt — a concurrent session's own /second-opinion run can overwrite it mid-review"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb2d4e0a-f5bc-476a-8468-9c82537ed523
  modified: 2026-08-16T20:15:15.651Z
---

The `/second-opinion` skill instructs writing the plan text to a fixed path,
`/tmp/check-plan.txt`, then launching a review agent that reads that file.
On a machine that routinely runs 15-20+ parallel Broadwayscore sessions, two
sessions calling `/second-opinion` around the same time collide on that path
— observed directly 2026-08-16: mid-review, a concurrent session's own
`/second-opinion` call overwrote the file with an unrelated plan (card
#1701's duplicate-task-mirror fix) while my review agent was about to read
it for task #1697's liveness-reconciliation plan.

**Why this matters:** the review agent would have silently reviewed the
wrong plan and returned a verdict that looked valid but covered nothing I
was about to implement — a false-pass that could let unreviewed
dispatch-layer code through the CLAUDE.md rule 18 gate.

**How to apply:** when the plan is short enough to fit inline, pass it
directly in the review agent's prompt text instead of relying on the agent
reading `/tmp/check-plan.txt` back — never trust that shared file to still
contain what you wrote by the time the agent reads it. If it's already
launched and might have read a stale/wrong version, send it a correction
message with the real plan inline and an explicit "ignore what you may have
read from that path" instruction (worked cleanly here). This is a latent bug
in the skill's own instructions (`ship-check`'s Codex step already
documents and fixes the identical class of hazard for its own shared-tmp-path
risk — mktemp per-run) — `/second-opinion` doesn't have that protection yet.
