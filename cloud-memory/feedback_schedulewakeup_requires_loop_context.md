---
name: schedulewakeup-requires-loop-context
description: ScheduleWakeup errors without a prompt and is unreliable even with one (a wakeup can silently never fire); to wait on CI or a background task, stay in-turn with a run_in_background Bash loop or Monitor.
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8fc1cc3a-9b9f-4c9a-a535-c304e55cf232
  modified: 2026-09-29T05:40:00.000Z
---

ScheduleWakeup errors (`prompt is required when stop is not true`) when called without a `prompt`; it is not a dependable general-purpose "wake me up later" tool.

**Why:** hit this twice in the same session (BRO-4070) trying to use it as a generic delay/backoff mechanism while waiting on a long-running background `Bash` task (a `land.yml` CI landing, ~19 min). Both calls errored immediately.

**Update 2026-09-28 (BRO-4236):** the error text is literal: the call fails only when `prompt` is omitted. With a `prompt` it schedules outside `/loop`, caps at 3600s, and does not prompt the owner. It is NOT reliable: in session_01SHmLUA3WZ9ubXrDUB9bowt one wakeup fired and a later one never did, and a refused land.yml run went unnoticed for ~1h. For anything that must be followed up, wait in-turn (run_in_background Bash loop or Monitor) instead.

**How to apply:** to wait on a background `Bash` task or poll external state (CI run status, a landing ref, a ledger row) without a `/loop` in play, use `Monitor` with a polling command instead — it streams events back without requiring a `/loop` prompt, and re-arms cleanly on expiry. Reserve `ScheduleWakeup` for actual `/loop` dynamic-pacing turns.
