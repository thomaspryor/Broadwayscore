---
name: Hook stdin format
description: PostToolUse hook stdin is nested under tool_input, not top-level — use jq '.tool_input.command' not '.command'
type: feedback
---

PostToolUse hook stdin JSON is `{"tool_input": {"command": "...", "file_path": "..."}}` — fields are nested under `tool_input`, not at the top level.

**Why:** The original `script-edit-check.sh` used `d.get('file_path','')` at the top level and was silently broken for its entire lifetime. Nobody noticed because the hook produced no output (empty file_path → no match → no output).

**How to apply:** When writing or modifying any Claude Code hook script, always use `jq -r '.tool_input.field_name // empty'` to access tool inputs. Never access fields at the top level.
