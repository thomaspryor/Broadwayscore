---
name: hook-stdin-format
description: "PostToolUse hook stdin is nested under tool_input, not top-level — use jq '.tool_input.command' not '.command'. Also: PreToolUse never carries a model field."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ce29b2be-150a-4b4d-a9f8-980497b2d88b
---

PostToolUse hook stdin JSON is `{"tool_input": {"command": "...", "file_path": "..."}}` — fields are nested under `tool_input`, not at the top level.

**Why:** The original `script-edit-check.sh` used `d.get('file_path','')` at the top level and was silently broken for its entire lifetime. Nobody noticed because the hook produced no output (empty file_path → no match → no output).

**How to apply:** When writing or modifying any Claude Code hook script, always use `jq -r '.tool_input.field_name // empty'` to access tool inputs. Never access fields at the top level.

**PreToolUse never carries a `model` field** (confirmed against code.claude.com/docs/en/hooks.md, 2026-07-13). Its top-level keys are `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input` — no model, no `$CLAUDE_MODEL` env var either. Only `SessionStart` optionally receives `model`, and it isn't guaranteed. A hook that needs the CURRENT model (e.g. to gate expensive-model fan-out) must fall back to the global `settings.json` `.model` — which misses in-session `/model` switches and can't distinguish concurrent parallel sessions on different models. To get it right, cache `model` from `SessionStart` into a per-session_id state file and have PreToolUse read that — `~/.claude/hooks/fanout-model-gate.sh` accepted the settings.json-fallback limitation instead (documented inline); the proper fix is carded in Notion (39d637c5-416f-8166-9368-ce76159dc030).
