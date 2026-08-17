---
name: project-notion-linear-cutover-sprint-plan
description: "Owner-approved 9-sprint plan (repo root sprint-plan-notion-linear-cutover.md) retires Notion, rewrites the gate hooks with a flippable board switch — check it before building ANY new Notion/Linear session-reporting or gate-hook infra"
metadata: 
  node_type: memory
  type: project
  originSessionId: 60709126-a693-4158-a155-cfc6ffd81ecc
  modified: 2026-08-17T04:37:36.411Z
---

`sprint-plan-notion-linear-cutover.md` (Broadwayscore repo root) is the authoritative, owner-approved plan to fully retire Notion and make Linear the sole board (source: `~/Documents/claude-outputs/notion-linear-cutover-plan-2026-08-15.md`, six-reviewer critique passed). Size L: 9 sprints, 64 tasks, one sprint per session. Sprint 0 complete 2026-08-17; Sprint 1 (safety rails — backoff, `--probe` mode, escape hatch, neutral marker) landing same day.

**Why this matters:** Sprint 4 ("Rewrite the hooks once, against a flippable board switch") rewrites the four existing Notion gate hooks (`notion-create-verify.sh`, `notion-card-required-commit.sh`, `notion-card-required-stop.sh`, `notion-mcp-block.sh`) into board-agnostic versions that read `~/.claude/board` (default `notion`, flip to `linear`) — ONE gate, not Notion-gate-plus-Linear-gate stacked.

BRO-387 ("Phase 1: Claude Code sessions must report status into Linear") was scoped and dispatched independently of this sprint plan and landed a parallel, narrower solution 2026-08-17 (`scripts/lib/linear-session-reporting.js`, `scripts/linear-session.js`, two NEW hooks `~/.claude/hooks/linear-issue-verify.sh` / `linear-issue-required-stop.sh` added alongside the Notion hooks, not replacing them). Neither doc references the other — flagged via a comment on the BRO-387 Linear issue for whoever runs Sprint 4 to reconcile.

**How to apply:** Before building ANY new Notion-card or Linear-issue session-reporting, gate-hook, or dispatch-claim infra, read `sprint-plan-notion-linear-cutover.md` first — check which sprint has landed (grep for `✅ COMPLETE` markers) and whether the work is already spoken for. If BRO-387's two hooks are still present when Sprint 4 starts, that's the reconciliation point — don't rediscover this collision from scratch. Related: [[project_linear_migration_decision.md]] (the earlier "retire the fleet" decision this sprint plan implements).
