---
name: schedulewakeup-requires-loop-context
description: ScheduleWakeup errors outside an active /loop prompt; use Monitor to wait on background bash tasks.
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8fc1cc3a-9b9f-4c9a-a535-c304e55cf232
  modified: 2026-09-23T08:38:44.100Z
---

ScheduleWakeup requires a `prompt` field tied to an active `/loop` (dynamic-mode) session and errors (`prompt is required when stop is not true`) when called outside that context — it is not a general-purpose "wake me up later" tool.

**Why:** hit this twice in the same session (BRO-4070) trying to use it as a generic delay/backoff mechanism while waiting on a long-running background `Bash` task (a `land.yml` CI landing, ~19 min). Both calls errored immediately.

**Update 2026-09-28 (BRO-4236):** the error text is literal: the call fails only when `prompt` is omitted. With a `prompt` it schedules and fires outside `/loop` (used 3x in session_01SHmLUA3WZ9ubXrDUB9bowt; the wakeup arrived as a new turn). It caps at 3600s and is the prompt-free replacement for `send_later`, which the blocker hook now denies.

**How to apply:** to wait on a background `Bash` task or poll external state (CI run status, a landing ref, a ledger row) without a `/loop` in play, use `Monitor` with a polling command instead — it streams events back without requiring a `/loop` prompt, and re-arms cleanly on expiry. Reserve `ScheduleWakeup` for actual `/loop` dynamic-pacing turns.
