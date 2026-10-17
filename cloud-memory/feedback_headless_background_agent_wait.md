---
name: feedback-headless-background-agent-wait
description: "in a headless (claude -p) job, use TaskOutput block=true to wait on a background Agent/Bash task in the SAME turn — ScheduleWakeup and task-notifications do not reliably resume the process after a turn ends"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ab657eca-f062-4686-ba8f-8fcd52400836
  modified: 2026-09-16T02:40:12.660Z
---

In a headless job (`claude -p` in a job worktree), backgrounded Agent/Bash tasks appeared to notify mid-session via `<task-notification>` several times in a row — which looked like proof that ending a turn while a background task ran was safe (the harness would "wake me up" later). It is not: `exit-status-gate.sh` explicitly warned that nothing wakes a headless session after the turn ends — background monitors, task notifications, and `ScheduleWakeup` never resume a `-p` session; when the turn ends the process exits and job-done is recorded, silently abandoning whatever was "still running." A prior incident (BRO-3388) stranded 2 commits this way, counted as success.

**Why:** `ScheduleWakeup` is built for `/loop` dynamic-mode sessions, not headless dispatch — using it (or just ending a turn hoping for a later notification) in a `claude -p` job is a category error, even though a few notifications happened to land while the process was still alive processing other tool calls in the same turn cycle.

**How to apply:** In a headless session, when you launch a background Agent or Bash task you need the result of, block on it synchronously in the SAME turn with `TaskOutput({task_id, block: true, timeout: <ms>})` rather than ending the turn and waiting for a `<task-notification>` or scheduling a wakeup. This is the correct way to run multiple reviewers/subagents "in parallel" from a headless job: launch them all, then `TaskOutput`-block on each one in turn to collect results before ending the turn. See [[feedback_headless_job_branch_no_auto_merge.md]] for the sibling lesson (must merge+push to main yourself — no supervisor lands it either).
