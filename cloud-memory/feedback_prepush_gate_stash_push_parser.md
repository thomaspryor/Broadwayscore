---
name: feedback_prepush_gate_stash_push_parser
description: "pre-push visual gate — `git stash push` in a compound command breaks its push-target parser; NO-VERIFY must be in the SAME turn as a standalone push"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fc18b1f-6174-4c6a-b243-9b51c71e27b1
---

The pre-push visual gate (`~/.claude/hooks/pre-push-visual-gate.sh`) blocked three consecutive push attempts on 2026-07-12 despite a valid NO-VERIFY bypass.

**Why:** Two interacting causes. (1) The hook's awk parser finds the FIRST `push` token in the command to locate the push target — `git stash push -u -m "x"` earlier in a compound command matches first, the target resolves to garbage, `DIFF_REF` falls back to `HEAD`, and in a worktree session HEAD is the worktree branch → UI files "changed" → gate fires even when pushing main. (2) The NO-VERIFY scan (`transcript-scan.mjs --query=visual-claim-language`, regex `NO-VERIFY:\s+\S+`) only looks at text blocks in the SAME assistant turn as the gated tool_use — bypass text in a *previous* turn does not count.

**How to apply:**
- Never combine `git stash push` (or anything containing the word `push`) with `git push` in one Bash call when UI files are in play. Do checkout/stash/pull/merge in one call, then `git push origin main` standalone.
- Put `NO-VERIFY: <reason>` in the assistant text of the SAME turn as the standalone push call.
- After 2 failed guesses at a hook's expectations, read the hook source (`sed -n '1,140p' ~/.claude/hooks/<hook>.sh`) instead of guessing a third time.
