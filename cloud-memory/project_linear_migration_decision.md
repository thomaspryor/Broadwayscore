---
name: project-linear-migration-decision
description: "Owner rejected repair of the Notion+cmux session system (2026-08-11); replacement plan (Linear + Cyrus + PR-gated Done) delivered, awaiting go/no-go — never propose \"the system is good, one more fix\" again"
metadata: 
  node_type: memory
  type: project
  originSessionId: 76cfeb74-28a2-45d0-bc25-b0c25b19e227
  modified: 2026-08-11T23:09:59.480Z
---

2026-08-11: After ~35 sessions proposing incremental fixes, the owner explicitly rejected repair of the Notion + cmux + dispatcher session system and asked for a best-in-class replacement. An evidence audit (verified from raw ledgers) found: 39% of "Done" cards fail next-day recheck (56/143), 30% workspace dead-launch rate over 7d (60% on 8/11, worsening), 48/420 dispatches abandoned, digest-autofix 4/17 success, ~94% of token spend was context replay (8/2 transcript audit), ~1/3 of open backlog is self-referential system cards.

**Why:** The failure is structural (self-reported Done, invisible local executor, self-generated workload, self-verified repairs). The owner is DONE with "your system is actually quite good, just fix X" answers — that framing is explicitly banned.

**How to apply:** Never propose repairing/tuning the cmux fleet, dispatcher, digest-autofix, or hook-gate layer as a solution to session-system pain. The recommended replacement: Linear as the only board (initiatives→projects→issues, mobile), Cyrus (official Linear agent-directory entry running Claude Code) or swappable runner, GitHub PR + CI checks as the non-skippable definition of Done. Migration sized at 2-3 days (curated ~120-150 card import from local task mirror; ~1,000 noise/self-referential records archived, not migrated). Full plan: ~/Documents/claude-outputs/retire-the-fleet-2026-08-11.md + artifact https://claude.ai/code/artifact/d1dbb044-7f4b-41c9-b7f5-b6d005b0865e. Owner constraint: needs full visibility + easy intervention (esp. from phone); not wedded to watch-every-session. As of 2026-08-11 the owner had NOT yet given the final go — check for a later decision before starting migration. Related: [[project_session_system_v2_overhaul]] (superseded by this direction if migration is approved).
