---
name: plan-parallel-means-subagents
description: "In /plan-tasks output, \"parallel tracks\" mean subagent-parallelism within one /execute-plan session — NOT multiple Claude Code sessions"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 405a75d7-f4ef-453c-b017-df5b3c38efcd
---

When a sprint plan from `/plan-tasks` lists "Track A / Track B / Track C" or "parallel sprints," that means **independent task chains that one Claude session can dispatch in parallel via subagents** — not three humans opening three Claude Code sessions.

**Why this rule exists:** twice now the user has been prompted (by me and by the plan's own wording) to open multiple Claude Code sessions in parallel "tracks." Both times it broke:

- Each session enters its own worktree off main → both push to the same remote → race conditions on shared files (audit JSONs, workflow YAMLs).
- The losing session's `git pull --rebase` quietly clobbers uncommitted edits in the winning session.
- One session hangs on an API rate limit mid-task with uncommitted work, leaving the worktree in an unknown state for the next session to clean up.
- The user spends time coordinating "which session is doing what" instead of getting work done.

**Why:** Coordinated subagent parallelism (one coordinator agent, many implementer subagents, shared git history) is the supported execution model for `/execute-plan`. Multi-session parallelism has no coordination layer — each session is blind to the others' commits, worktrees, and in-flight edits.

**How to apply:**
- When reading a plan with "Track A/B/C": those run within ONE session via subagents. Don't suggest the user open more sessions.
- If a plan is too big for one session's context window, the answer is **sequential sprints across multiple sessions** (Session 1 ships Sprint 1 to main; Session 2 picks up Sprint 2 on a clean main; etc.) — not parallel sessions running concurrently.
- If the user already has multiple sessions running by accident, ask them to close the others before continuing. Salvage in-flight uncommitted work from the closed session's worktree.
- The `/plan-tasks` skill was updated 2026-05-16 to label tracks "Subagent track N" and warn explicitly against multi-session execution. If a plan still uses ambiguous "Agent/Person" wording, flag it.

**Don't trust your own past plans on this.** I wrote `sprint-plan-critic-coverage.md` myself with "Track A (Sonnet) / Track B (Sonnet) / Track C (Opus)" wording. When the user asked "can a parallel session start on S2?" I answered as if multi-session was a normal mode, then had to walk it back when they pointed out the design.

**Related:**
- [[feedback_parallel_worktree_race]] — the actual git failure mode when multiple sessions race
- [[feedback_worktree_code_changes]] — worktree-first is mandatory but doesn't protect against cross-session races on shared remote
