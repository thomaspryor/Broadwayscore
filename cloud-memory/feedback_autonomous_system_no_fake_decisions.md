---
name: feedback-autonomous-system-no-fake-decisions
description: "Don't offer \"I do it vs you do it\" as a DECISION NEEDED when the answer is obviously autonomous — writing acceptance criteria, dispatch bars, etc. are technical work, not owner judgment calls"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a1834152-8c3d-48fe-8b08-a6e22e4b63ad
  modified: 2026-08-18T00:48:38.616Z
---

Never frame "should I write X myself, or should you write it" as a DECISION NEEDED block. The system being built (Linear migration, autonomous dispatch) is explicitly meant to run without the owner hand-writing things like acceptance-criteria bars — offering that choice is itself the mistake, not just picking the wrong default.

**Why:** User reaction 2026-08-17: "I'd never write it that was a stupid decision to give" — after I asked whether to write acceptance criteria for blocked P0 Linear issues (BRO-280/378/282) myself or have the owner write them. The owner had just said the whole point is the system runs autonomously.

**How to apply:** For P0/P1 dispatch blockers that need a technical bar defined (verify commands, acceptance criteria, done-definitions) — write it myself and dispatch, don't ask. Reserve real DECISION NEEDED blocks for product direction, money, or irreversible actions per [[feedback_no_review_offers_user_not_technical.md]] — "what should the acceptance bar be" is not one of those when the owner has already established the system should self-serve this.
