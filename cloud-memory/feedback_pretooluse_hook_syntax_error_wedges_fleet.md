---
name: feedback-pretooluse-hook-syntax-error-wedges-fleet
description: "A bash syntax error in a shared PreToolUse hook script blocks every Bash/Edit/Write call in every session on the machine, bypassing the hook's own fail-open design — diagnose with Read + the `!` prefix, not by retrying."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f9545ecd-4afb-478f-81d3-292e02b0cee4
  modified: 2026-08-06T18:51:12.972Z
---

A syntax error in a shared PreToolUse hook (e.g. `~/.claude/hooks/*.sh`) blocks
**every** Bash/Edit/Write tool call, in **every** session on the machine —
including the session whose edit caused it — because bash fails to parse the
whole script file before any code runs. This happens even when the hook was
carefully designed to "fail open" (e.g. wrapping its classification logic in
`verdict_out=$( set +e; ... )` so a *runtime* error inside exits 0): a
*parse-time* syntax error aborts before that protective structure ever
executes, so the fail-open guarantee doesn't apply.

**Why:** Confirmed live 2026-08-06 — a concurrent session's in-progress edit
to `infra-plan-review-gate.sh` (adding a `_node_bounded()` timeout wrapper)
left a stray `}` with no matching `{`. Every `Bash`/`Edit`/`Write` call from
every session on the Mac (mine included) failed with `PreToolUse:Bash hook
error: ... syntax error near unexpected token '}'` for several minutes, and
the session that broke it — and the session that discovered it — were both
structurally unable to fix it, since Edit/Write/Bash all route through the
same broken hook. Only the owner running a raw shell command outside the
tool-gated path (or the `!` prefix) could unwedge it.

**How to apply:** If Bash/Edit/Write suddenly start failing identically
across *unrelated* commands with a `PreToolUse:<Tool> hook error:` prefix
naming a shell syntax error (not a deliberate block message with a repair
suggestion), assume the shared hook script itself is broken, not that your
command is wrong:
1. Don't retry the same tool call — it will fail identically every time until
   the file is fixed.
2. Use `Read` on the hook file — Read isn't gated by PreToolUse hooks matched
   to Edit/Write/MultiEdit/NotebookEdit/Bash, so it still works and lets you
   diagnose the exact syntax break.
3. If you can't self-repair (Edit/Bash both blocked), tell the user directly
   and hand them the exact diagnostic/fix command to run via the `!` prefix
   (bypasses the same tool gate) — don't spin retrying.
4. Once fixed, re-verify with a trivial `true`/`echo` call before resuming
   real work; don't assume a user's "should be fixed" report is confirmed.
