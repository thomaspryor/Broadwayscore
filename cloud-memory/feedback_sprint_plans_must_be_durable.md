---
name: sprint-plans-must-be-durable
description: Sprint plans / handoff docs referenced by Notion or task cards must live in a durable path (~/Documents/claude-outputs or the repo) — session scratchpad paths die with the session
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c4ee17a5-429a-42fb-ab80-403be3887e66
---

The Sprint 2 dispatch card (task #44, 2026-07-13) pointed at `scratchpad/plans/commercial-scorecard-sprint-plan.md`, which lived in the planning session's per-session scratchpad and was gone by execution time. The sprint had to be reconstructed from the Notion card outcome + Sprint 1 commits (~15 min of forensics).

**Why:** `/private/tmp/claude-501/.../scratchpad/` is session-specific; repo-root `scratchpad/` doesn't exist and isn't tracked. Any cross-session pointer to either silently dangles.

**How to apply:** When writing a plan another session will execute (sprint plans, handoff docs, seed prompts), save it to `~/Documents/claude-outputs/` (per global rule) or a tracked repo path — and put THAT path in the card. When consuming a card whose plan path 404s, reconstruct from the plan card's Outcome section + the prior sprint's merge commit before asking the user.
