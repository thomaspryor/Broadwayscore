---
name: decide-technical-calls-myself
description: "User is non-technical — make technical/implementation decisions yourself (verify with another agent when stakes are high); never frame them as \"your call\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 195cd6dd-f7dc-488c-865c-c5faf430e356
---

The user is NOT technical and explicitly cannot make technical/implementation decisions. Framing a technical choice as "this is genuinely your call" is unhelpful and frustrating to them (stated 2026-06-04, and consistent with [[feedback_no_review_offers_user_not_technical]] / [[feedback_user_device_context]]).

**Why:** they hired the agent to make these calls; punting an implementation decision back to them ("worktree vs env var?", "which provisioning mechanism?") just blocks progress on a question they can't answer.

**How to apply:**
- Make the technical decision yourself. State it briefly and proceed.
- When a technical call is high-stakes or irreversible, get a SECOND OPINION from another agent / `/plan-review` / `/second-opinion` and proceed on the verified recommendation — don't route it to the user.
- Use AskUserQuestion ONLY for genuinely user-domain choices: cost/budget tradeoffs, product behavior/UX, what to prioritize, risk they'd personally care about, anything affecting their daily workflow in a way they'd feel. Even then, lead with a clear recommendation ([[feedback_ask_with_recommendation]]).
- Never say "your call" / "you decide" about mechanics (clones, hooks, schemas, isolation strategy, etc.).
