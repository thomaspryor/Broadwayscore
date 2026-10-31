---
name: Claude Code hook events inventory (all 26) and what we use vs what's available
description: "26 hook events; we use 7. Untapped: InstructionsLoaded, sessionTitle."
type: reference
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
archived: true
---
**Source:** Pulled from official docs at https://code.claude.com/docs/en/hooks-guide and the changelog on 2026-04-10. Re-fetch periodically — Claude Code adds events frequently.

## Complete event list (26 events)

| Event | Fires when | Can block? | We use? |
|---|---|---|---|
| `SessionStart` | Session begins or resumes | No | ✅ session-start.sh |
| `UserPromptSubmit` | Prompt submitted, before processing | Via additionalContext | ❌ |
| `PreToolUse` | Before tool execution | ✅ Yes (deny/exit 2) | ✅ notion-mcp-block.sh |
| `PermissionRequest` | Permission dialog about to show | Via JSON decision | ❌ |
| `PermissionDenied` | Tool denied by auto mode classifier | Via `{retry: true}` | ❌ |
| `PostToolUse` | After tool succeeds | No | ✅ commit-check.sh, script-edit-check.sh |
| `PostToolUseFailure` | After tool fails | No | ❌ — could detect repeated failures |
| `Notification` | Claude sends notification | No | ✅ notify.sh |
| `SubagentStart` | Subagent spawned | No | ❌ |
| `SubagentStop` | Subagent finishes | No | ❌ |
| `TaskCreated` | Task created via TaskCreate | No | ❌ |
| `TaskCompleted` | Task marked completed | No | ❌ |
| `Stop` | Claude finishes responding (every turn) | Via decision:block | ✅ verify-edits.sh, session-stop.sh |
| `StopFailure` | Turn ends due to API error | No | ❌ |
| `TeammateIdle` | Agent team teammate goes idle | No | ❌ |
| **`InstructionsLoaded`** | CLAUDE.md / `.claude/rules/*.md` loaded | No | ❌ — **HIGH VALUE for integrity check** |
| **`ConfigChange`** | Config file changes during session | Via decision:block | ❌ — **HIGH VALUE for "external linter modified file" detection** |
| **`CwdChanged`** | Working directory changes | No | ❌ |
| **`FileChanged`** | Watched file changes on disk | No | ❌ — **HIGH VALUE for CI data race detection** |
| `WorktreeCreate` | Worktree being created | Replaces default | ❌ |
| `WorktreeRemove` | Worktree being removed | No | ❌ |
| `PreCompact` | Before context compaction | No | ❌ |
| `PostCompact` | After compaction completes | No | ❌ |
| `Elicitation` | MCP server requests user input | No | ❌ |
| `ElicitationResult` | After user responds to MCP elicitation | No | ❌ |
| `SessionEnd` | Session terminates | No | ❌ — distinct from Stop, fires once |

## Three handler types (we only use one)

1. **`type: "command"`** — shell script via stdin/stdout/exit codes. **What we use everywhere.**
2. **`type: "prompt"`** — Claude Haiku makes a yes/no decision. Returns `{"ok": true|false, "reason": "..."}`. Costs API calls but catches semantic violations a deterministic script can't.
3. **`type: "agent"`** — spawns a subagent with Read/Grep/Glob tools. Up to 50 turns, default 60s timeout. Use when verification needs to inspect actual codebase state.
4. **`type: "http"`** — POST event JSON to a URL. Same response format as command. Useful for shared team services.

## NEW: `if` field for tool hooks (v2.1.85+)

The `matcher` field filters at the group level by tool name. The new `if` field uses **permission rule syntax** to filter by tool name AND arguments together — the hook process only spawns when the call matches:

```json
{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "if": "Bash(git commit*)",
    "command": "bash ~/.claude/hooks/commit-check.sh"
  }]
}
```

This is more efficient than spawning the script and grep'ing inside it. Patterns: `"Bash(git *)"`, `"Edit(*.ts)"`, `"Edit(src/api/*)"`.

**Only works on tool events:** PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied. Adding it to other events prevents the hook from running.

## Decision JSON format (alternative to exit 2)

For PreToolUse, exit 0 with this JSON instead of exit 2 for richer control:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny|allow|ask",
    "permissionDecisionReason": "..."
  }
}
```

`"allow"` skips the interactive prompt but doesn't override deny rules in settings — hooks can tighten restrictions but can't loosen them past what permission rules allow.

PreToolUse hooks fire **before** any permission-mode check, so a hook returning `"deny"` blocks the tool even in `bypassPermissions` mode or with `--dangerously-skip-permissions`. Use this for non-bypassable policy.

## Known gotchas

- **Exit 2 blocks. Exit 1 silently does nothing.** A hook that uses exit 1 instead of exit 2 looks like it works but provides zero enforcement. Always exit 2 to enforce.
- **Stop hook infinite loop:** if a Stop hook returns `decision:block` repeatedly, Claude loops forever. Use `stop_hook_active` field in stdin to detect "I already blocked this turn" and exit early.
- **JSON parse errors:** if `~/.zshrc` has unconditional `echo` statements, the output prepends to your hook's JSON output and breaks parsing. Wrap profile echos in `[[ $- == *i* ]]` (interactive shell check).
- **Multiple hooks updating same tool input:** when multiple PreToolUse hooks return `updatedInput`, last-finishing wins. Hooks run in parallel so order is non-deterministic. Avoid having more than one hook modify the same tool's input.
- **`PermissionRequest` doesn't fire in non-interactive mode (`-p`).** Use PreToolUse for automated permission decisions in headless flows.

## Highest-value events we're not using yet

**`InstructionsLoaded`** (fires when CLAUDE.md or `.claude/rules/*.md` is loaded, including lazy loads mid-session)
- **Use case:** Replace the manual grep-based integrity check in `session-start.sh` with a hook that fires every time CLAUDE.md is loaded — including mid-session reloads after an external linter or merge modifies it. Catches the "CLAUDE.md silently reverted" scenario across the entire session, not just at startup.
- **Matcher values:** `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`

**`ConfigChange`** (fires when settings.json, skill files, or rules files change during a session)
- **Use case:** Addresses the recurring "external tool modified my files" pain point documented in `feedback_layout_head_formatter.md`, `feedback_validator_baseline_worktree.md`, `feedback_review_texts_ci_overwrites.md`, `feedback_pipeline_reintroduces_drift.md`. Currently the rule is "always git diff after a hook runs" — manual and easily forgotten. A `ConfigChange` hook can warn the assistant (or block) automatically.
- **Matcher values:** `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`

**`FileChanged`** (fires when a watched file changes on disk; matcher is a literal `|`-separated list of filenames, NOT regex)
- **Use case:** Watch `data/shows.json` and other CI-touched files. When CI commits land mid-session, the hook can warn the assistant to `git pull` before continuing — addresses `feedback_worktree_data_races.md` and the `git pull before every shows.json edit` rule from CLAUDE.md §1.

**`UserPromptSubmit`** with `hookSpecificOutput.sessionTitle`
- **Use case:** Auto-set the session title from the first user prompt. Replaces manual `/rename` calls. Single hook, fires once on first prompt.
- Also supports `additionalContext` to inject text before Claude processes the prompt — could inject current Notion in-progress card name into every prompt.

**`PostToolUseFailure`** (separate event for tool failures)
- **Use case:** Detect 3+ failures of the same tool in a row → suggest `/stuck` automatically.

## Lower-priority but interesting

- **`PreCompact` / `PostCompact`** — write critical state to a file before compaction, re-inject after. We use `SessionStart` with `compact` matcher for the latter; PreCompact would let us preserve state DURING compaction.
- **Subagent memory frontmatter** (v2.1.33, Feb 2026) — each subagent gets its own persistent markdown knowledge store. First 200 lines injected at startup. Could give the `Explore` and `Plan` subagents project-specific gotcha lists.
- **Skills `effort` frontmatter** (v2.1.98) — override model effort level. Note: this is for skills (folder with SKILL.md), not commands (single .md file in commands/). Our `/plan-review` etc. are commands, so `effort` won't apply unless we convert them to skills.
- **Statusline `refreshInterval`** — re-run statusline command every N seconds. Could show live Notion in-progress card name + CI status.
- **`includeGitInstructions: false`** — removes built-in git/PR instructions from system prompt. We have our own in CLAUDE.md, so this saves tokens. But verify what it removes before enabling.

## Settings we already enabled (2026-04-10)

- `disableDeepLinkRegistration: true` — security hardening, prevents `claude-cli://` protocol handler registration
- `if: "Bash(git commit*)"` on commit-check.sh — efficiency improvement, hook only spawns on git commit (not every Bash)

## Documentation links

- Hooks guide: https://code.claude.com/docs/en/hooks-guide
- Hooks reference (full schemas): https://code.claude.com/docs/en/hooks
- Changelog: https://code.claude.com/docs/en/changelog
