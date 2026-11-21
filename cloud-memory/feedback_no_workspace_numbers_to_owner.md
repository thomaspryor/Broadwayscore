---
name: feedback-no-workspace-numbers-to-owner
description: "Never quote cmux workspace refs/numbers (workspace:271) to the owner — they can't see numbers; always use the workspace TITLE"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 838953b4-a5e1-41f7-91d1-8844aba6be07
  modified: 2026-07-24T14:22:19.577Z
---

Never reference cmux workspaces by ref/number (e.g. "workspace:271", "tab 285") in any owner-facing text — messages, reports, alert emails, Notion cards the owner reads. The owner's cmux UI shows TITLES only; numbers are meaningless to them (owner request 2026-07-24, during the opening-night monitor first live night).

**Why:** I told the owner "close workspaces 284-287" and they could not act on it at all.

**How to apply:** Always name workspaces by their visible title ("the 🎭🧠 ON monitor·trainspotting tab", "zz-test-focus"). Refs are fine in logs, ledgers, and code. Owner-facing alert templates (opening-night-monitor-launch escalation emails currently print `workspaceRef`) should print the launch title instead — tracked in the cmux-launch P2 card [[3a7637c5-416f-81d3]].
