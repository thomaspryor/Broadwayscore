---
name: feedback_duplicate_dispatch_check_listagents
description: Check ListAgents for a peer session on the same Linear/Notion issue before investing deep work
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8c0c1231-48f4-4b6e-96e7-b99ce0de6d5d
  modified: 2026-08-26T14:41:00.531Z
---

When starting a dispatched task tied to a specific issue ID (Linear/Notion), run `ListAgents` early and scan peer-session names for the same issue ID (e.g. `job-linear-bro-2314-*`) before sinking significant investigation time into the fix.

**Why:** BRO-2314 was double-dispatched to two sessions. Both independently did deep root-cause work before either checked for a duplicate — caught only when a second-opinion scratch file collision (`/tmp/check-plan.txt`, non-session-scoped, see feedback sent 2026-08-26) surfaced the other session's plan mid-review. Coordinating early (SendMessage to the peer) let the two plans merge into one better design (peer's `.gitattributes` merge-driver discovery + my empirical git-plumbing verification) instead of two competing, partially-worse implementations landing separately or conflicting on push.

**How to apply:** For any tab/session dispatched against a named issue, check `ListAgents` for a same-issue peer near the start of the session (not just when a collision is stumbled into). If found, SendMessage to compare progress/approach before either side edits shared files — whoever is further along or has the better design drives; the other stands down and defers Linear/Notion reporting to the driver.
