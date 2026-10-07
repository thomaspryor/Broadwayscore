---
name: feedback_codex_review_data_check_preflight
description: Codex CLI adversarial ship-check reviews stop and refuse if not explicitly told to skip npm run data:check / setup commands
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ff7e9646-4e21-491e-9b03-5f0d2a625ce0
  modified: 2026-08-17T14:53:14.491Z
---

`codex exec --sandbox read-only` invoked for a ship-check adversarial review will try to run `npm run data:check` (or similar setup) as a preflight, because it reads root `CLAUDE.md`'s session-start rule and follows it literally — even under an explicit "review this diff" prompt. In a read-only sandbox with no data checkout, that command fails, and Codex reports "Blocked by required preflight" and stops without reviewing anything (zero tokens spent on the actual review, easy to mistake for a working-but-empty pass).

**Why:** Codex has full repo read access including CLAUDE.md, and treats its rules as binding instructions, not just context. It did this on the [[project_cv_wrongproduction_lifetime_sweep]] ship-check run (2026-08-17) — first attempt returned only a preflight-blocked message; adding one explicit line ("Do NOT run `npm run data:check`, `npm install`, or any other setup/preflight command — read the files directly") to the prompt fixed it on retry.

**How to apply:** When building a Codex/gpt-5.4-mini adversarial review prompt (ship-check Phase 5, reviewer 3) for a Broadwayscore diff, always include an explicit "do not run setup/data-check commands, just Read/Grep the files" line. Also prefer `codex exec ... - < promptfile` (stdin) over `codex exec ... "$(cat promptfile)"` (command substitution) — the Bash sandbox in this harness sometimes rejects the latter as "too complex to verify stays inside worktree" when run from an EnterWorktree session.
