---
name: project-session-system-v2-overhaul
description: "OWNER-APPROVED program (2026-08-02) to overhaul the multi-session system — S0-S4 fixes then v2 subtraction (queue-first, hooks 34→~10, platform-native); plan + audit live in claude-outputs; do NOT re-ask approval"
metadata: 
  node_type: memory
  type: project
  originSessionId: e19099b6-fa29-4589-8df9-664fa3e768d6
  modified: 2026-08-02T23:38:45.591Z
---

On 2026-08-02 the owner approved **Option A: full v2 subtraction, phased** for the session-system overhaul, saying "A for sure. Your job is to get this system fully implemented, all the way through." Do not re-ask; the whole program is pre-approved.

Program spec (read before touching it): `~/Documents/claude-outputs/session-system-fix-plan-2026-08-02.md`
Evidence base: `~/Documents/claude-outputs/session-system-audit-2026-08-02.md` (5-day transcript audit, 306 sessions: 94% of spend was context replay; 160K-token task reminder injected 3,507x; 1,401 hook blocks; Gate W holes proven; auto-dispatch was the one enforcement that worked).

State at creation: S0 (#853) + S1 (#854) dispatched to cmux workspaces 346/347 and running; S2 #855, S3 #856, S4 #857 queued; V1 #867, V2 #868, V3 #869 blocked behind them.

**Why:** the audit proved the enforcement layer and ~20-tab fleet generate the failures they police; subtraction with canary discipline is the fix, not more guardrails.
**How to apply:** any session picking up tasks #853-857/#867-869 reads the plan file top-to-bottom first (ground rules: never edit live hooks in place, bash -n + atomic swap, canary, kill-switch flags, both hook copies + drift check, RECHECK-AFTER for deferred-effect acceptance). Sequencing: S2 after S0; S3 after S2; V1 after S3+48h; V2 after S2+V1; V3 after V1. Related: [[feedback_worktree_code_changes]], [[autonomous-loop-schedule]].
