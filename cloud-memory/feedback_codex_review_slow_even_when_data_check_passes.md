---
name: feedback_codex_review_slow_even_when_data_check_passes
description: "Codex CLI adversarial ship-check review can take 2+ min re-exploring the repo (npm run data:check, nl -ba full-file reads, rg greps) even when data:check succeeds and the diff+context were already given in the prompt"
metadata:
  node_type: memory
  type: feedback
  originSessionId: BRO-109-headless
  modified: 2026-08-20T20:38:36.870Z
---

`/ship-check`'s Codex adversarial-review step (`codex exec --sandbox read-only`) can still take well over 2 minutes even when the `npm run data:check` preflight succeeds (unlike the bail case in [[feedback_codex_review_data_check_preflight]]/[[feedback_codex_review_data_check_bail]]) — it re-derives context by reading the full target file with `nl -ba` and grepping the whole repo (`.github`, `scripts`, `tests`) before producing any findings, even though the diff and surrounding context were already pasted into the prompt.

**Why:** Codex treats "you have read access, use Read/Grep" in the prompt as an instruction to actually re-explore, not just an affordance — it doesn't trust the pasted diff alone. On a headless/cloud session (BRO-109, 2026-08-20) this ate a full 2-minute timeout with no usable output, forcing a fallback.

**How to apply:** For a Broadwayscore ship-check Codex review, budget at least 3-4 minutes (not the skill's example 2-min implicit budget) before treating it as hung, OR add an explicit line to the prompt: "the diff below already contains everything you need — do not re-read the full files or grep the repo, just review the diff text." If OPENAI_API_KEY is unset (true on at least one cloud/headless environment, confirmed 2026-08-20) the gpt-5.4-mini fallback is also unavailable — fall to a Claude subagent adversarial reviewer immediately rather than trying both external paths, and say so plainly in the ship-check coverage banner.
