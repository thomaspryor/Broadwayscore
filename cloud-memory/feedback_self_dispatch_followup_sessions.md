---
name: feedback-self-dispatch-followup-sessions
description: "Never end multi-session work with a paste-this-prompt handoff — launch the next session yourself via cmux/bsc-next; owner called manual re-dispatch \"really annoyingly manual\" (2026-07-12)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: db824ddf-3803-441d-b3a6-6114a2d42968
---

Ending a sprint/phase session with "paste this handoff prompt into a new session" makes the owner the dispatcher. They flagged this on 2026-07-12 after Sprint 1 of the autonomous loop: "Why are you not kicking off Sprint 2 automatically? … really annoyingly manual."

**Why:** The owner's global rule is "never ask the user to do things you can do." Session dispatch IS something a session can do: `cmux new-workspace --cwd ~/Broadwayscore --command 'claude --dangerously-skip-permissions "$(cat <seedfile>)"'` (the exact pattern scripts/bsc-next.js launchCmux uses), or `node scripts/bsc-next.js --id <taskId>` when the shared-task seed is good enough.

**How to apply:** When wrap-up hands off to a planned next session (next sprint, phase 2, resume-after-deploy): (1) write the seed prompt to a file — task list, what shipped (commits), carry-forwards, pointers to the card/plan; (2) launch the workspace yourself; (3) tell the owner it's running. Only end with a written-but-not-launched seed when a genuine human/overnight gate blocks the next phase (e.g. "first live night must complete") — and then name the exact unblocking event. Encoded for the autonomous-loop chain in ~/Documents/claude-outputs/sprint-plan-autonomous-loop.md (Cross-session plan). Related: [[feedback_next_steps_actionable]], [[autonomous-loop-schedule]].
