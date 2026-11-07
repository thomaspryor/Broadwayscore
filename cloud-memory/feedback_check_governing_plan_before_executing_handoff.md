---
name: feedback_check_governing_plan_before_executing_handoff
description: "Before executing a build-owner handoff or continuation doc, find and read the reviewed plan it belongs to — handoffs carry tactics and silently omit the architecture decisions that would invalidate them"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5d3ef1b1-4a27-49cc-92aa-993b1ad8f54f
  modified: 2026-08-16T14:08:33.852Z
---

A handoff document tells you what the previous session was doing. It does not
tell you whether that was the right thing to be doing.

2026-08-15/16: a session executed `build-owner-handoff-2026-08-15.md` for six
hours, root-caused two real blockers, and shipped a working Linear→Mac webhook
relay. Only when the owner asked "who owns this system?" did the session read
`retire-the-fleet-2026-08-11.md` — the six-reviewer-approved plan governing the
same work — which specifies **hosted runners and explicitly rules out the Mac
Studio**, because the invisible local executor is the exact failure that plan
exists to retire. The owner had also already approved the paid hosted option
elsewhere. The transport work became a fallback nobody asked for.

**Why:** handoff docs are written at the end of a session under context
pressure. They carry tactics, open threads and gotchas — and they routinely
omit the strategic frame, because the author still had it in their head. The
omission is invisible: nothing in the handoff says "a plan governs this."

**How to apply:** before starting work described by any handoff, continuation
doc, or "pick up where I left off" prompt, spend two minutes finding the plan:
`ls -t ~/Documents/claude-outputs/ | head -20`, grep it and `memory/` for the
project noun (here: cyrus, linear, fleet), and read any `project_*.md` memory
whose description matches. Then ask explicitly: **does the plan constrain the
architecture I am about to build in?** If the handoff and the plan disagree,
that is the first thing to raise with the owner — before writing code, not
after shipping it. Check too whether a pending owner decision (a due-dated card,
a billing deadline) already settles the question the work assumes is open.

Related: [[project_linear_migration_decision]],
[[feedback_sprint_plans_must_be_durable]],
[[feedback_investigate_premise_before_scaling]].
