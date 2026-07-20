---
name: subagent-model-inheritance-cost
description: "Subagents and bsc-next dispatches inherit the parent/interactive model — from a Fable session, every reviewer panel and dispatched workspace runs Fable-at-high-effort unless a model is passed explicitly. 48h spend spike 2026-07-12/13."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2c006d21-7eb3-46bd-8d52-7ddea9174639
---

Fable-session fan-out is the #1 hidden cost: on 2026-07-12/13 a two-day Fable orchestration session spawned ~15 review subagents (two 6-reviewer panels, sweeps, forensics) and ~9 bsc-next workspaces — all inheriting Fable at high effort. The autonomous loop's own metered spend was $0.42; the inheritance spend dwarfed it.

**Why:** the Agent tool and `claude` launches default to the session/interactive model; the loop's Sonnet-first policy only governs the nightly executor's internal calls.

**How to apply:**
- When spawning subagents from an expensive-model session, pass `model: 'sonnet'` (mechanical/search/sweep) or `model: 'opus'` (adversarial verify, design review) explicitly — reserve parent-model inheritance for tasks that genuinely need it.
- bsc-next now pins `--model sonnet` on all dispatches (override `--model opus` per card) — commit 95b5a5286a3; don't regress this.
- In-session Agent/Task/Workflow fan-out is now enforced (not just advisory): `~/.claude/hooks/fanout-model-gate.sh` (PreToolUse) blocks a Fable-session subagent call with no explicit `model` param — pass `model:"sonnet"`/`"opus"` or add `FABLE-FANOUT-OK: <reason>` to inherit deliberately.
- Related: [[autonomous-loop-schedule]] — the loop's ledger only meters its own calls; interactive/dispatch spend is invisible to the morning email's "loop" line (account-level visibility needs ANTHROPIC_ADMIN_KEY).
