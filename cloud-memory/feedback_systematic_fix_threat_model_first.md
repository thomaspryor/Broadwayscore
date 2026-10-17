---
name: systematic-fix-threat-model-first
description: "Before scaling \"systematic\" defenses, check how often the buggy path actually runs. Manual-only scripts that fire once every 80 days don't justify the same defense depth as continuous scrapers."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ac76a05e-1b22-4ee5-9411-ec675bcd9542
---

When asked to make a fix "systematic", first check the threat model: how often does the buggy code path actually execute? A defense that's appropriate for a daily cron is overkill for a manual-only script that hasn't run in 3 months.

**Example (2026-05-24):** `backfill-cast-web.yml` is `workflow_dispatch` only — no `schedule`, no `workflow_run` triggers. Last 5 runs were all on 2026-03-03. Eighty days idle. Two ambitious "systematic" defenses were initially proposed:
- Generalized role-shape heuristic (catch novel TV-title patterns)
- IBDB cross-reference at write time (validate every name)

Both got second-opinion-reviewed and SKIPPED:
- Role-shape: shape-collides with real character names ("Atticus Finch" indistinguishable from "Top Boy"). FP cost on real cast > miss cost on novel patterns.
- IBDB cross-ref: ~85% false-rejection on UK/Irish/OB actors (IBDB only tracks Broadway). Adds SERP cost to a pipeline that runs every 80 days.

What was kept (cheap, threat-model-appropriate):
- CI gate in test.yml — catches anyone committing contaminated data, runs every push.
- Opera-source-domain blocklist — 6-line lookup table, prevents 1 specific recurrence.
- Word-boundary regex fix — actual bug, not speculative defense.

**How to apply:**
- For any "systematic fix" proposal, ask: how often does the buggy path run? Manual once a quarter? Daily cron? Real-time user input?
- The defense depth should scale to the trigger frequency.
- A 4-layer defense for a never-running script is over-engineering. The CI gate is enough.
- Second-opinion any defense that adds API cost, latency, or false-positive risk to catch a problem that hasn't recurred in months.
- See [[ship-check-finds-real-bugs]] for the parallel review pattern.
