---
name: feedback_hook_transcript_text_flush_lag
description: "Transcript-scanning hooks structurally cannot see in-flight assistant text — never write a new PreToolUse or Stop hook that scans transcript_path for the CURRENT turn's bypass tokens or claims"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d5f48ae0-8a46-4e96-a397-cb5673fcf380
  modified: 2026-07-20T15:12:06.614Z
---

Assistant text blocks reach the transcript JSONL at least one message behind, and text from a turn whose tool call got hook-BLOCKED never lands in the transcript at all (confirmed 2026-07-20, session e1dca052; audited + fixed across ~/.claude/hooks/*.sh in Notion card #233). A PreToolUse hook scanning `transcript_path` for a bypass token (e.g. `NO-VERIFY:`) in "the in-flight turn" can never see it — not rarely, structurally never, including on retries, because the retry's own text is equally unflushed. Stop hooks are similar but narrower: tool_use/tool_result entries ARE flushed by Stop time, only the trailing text-only final message is not.

**Why:** discovered when a NO-VERIFY bypass silently failed to clear pre-push-visual-gate.sh — the transcript scan had zero chance of seeing it regardless of wording or retry count.

**How to apply:** when writing or reviewing a hook that needs the CURRENT turn's text:
- **PreToolUse:** don't scan the transcript for it. Use a channel guaranteed present in the hook's own stdin payload instead — e.g. a `# TOKEN: <reason>` shell-comment embedded in the gated command string itself (pattern: `pre-push-visual-gate.sh`, `pre-push-review-gate.sh`). Accepted residual gap: a `#`-preceded-by-whitespace anchor can't distinguish a real trailing comment from a heredoc-body line or a quoted commit-message argument — low severity since it guards the assistant's own discipline, not a hostile actor, and every use is logged.
- **Stop:** the harness passes the live final text separately as `last_assistant_message` in the hook's JSON stdin (NOT in the transcript file yet). Capture it into an env var, export it BEFORE spawning the python3 subprocess, then inside the heredoc append it as a synthetic `('text', msg)` event onto whatever event list the hook already builds from the transcript — this makes both "most-recent-text" backward scans and "text-from-index-N-onward" forward scans see it without touching their logic. Reference implementation: `finish-line-gate.sh` (`FLG_LAST_MSG`, first to get this right); also applied to `verify-edits.sh`, `anti-slop-check.sh`, `notion-card-required-stop.sh`.
- Hooks that only read tool_use/tool_result data (not assistant TEXT) — `fanout-model-gate.sh`, `session-stop.sh` — have no exposure and need no fix.
