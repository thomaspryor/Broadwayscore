---
name: Measure hook stdout/stderr surfacing empirically — don't trust docs
description: "Measure stdout/stderr surfacing empirically before shipping a hook."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
archived: true
---
**Rule:** Before shipping a new hook that relies on stdout OR stderr being surfaced to the assistant, **measure empirically** against real transcripts. Don't trust the docs. Don't trust the pattern in another hook. Each Claude Code hook event has its own stdout/stderr handling, and the docs are incomplete.

**Why this rule exists:**

2026-04-11: I shipped a `ConfigChange` hook with `stdout + exit 0` on the assumption that stdout surfaces to the assistant the same way `session-stop.sh`'s does. The `/second-opinion` reviewer who critiqued the plan pointed at `session-stop.sh:52-59` as the "established precedent" and I followed the advice. The hook passed 6/6 fixture tests + live E2E.

The next day I measured empirically by grepping every session transcript in `~/.claude/projects/-Users-tompryor-Broadwayscore/*.jsonl` for the banner text. Result: the hook had fired 45 times across 22 real sessions, and **0 transcripts contained the banner.** Not a single real session ever saw the warning. Stdout-on-exit-0 for ConfigChange goes into a black hole.

Measured comparison across hooks as of 2026-04-11:

| Hook | Channel | Sessions that actually saw it |
|---|---|---|
| `session-stop.sh` | stdout + exit 0 | 35 ✅ |
| `notion-mcp-block.sh` | stderr + exit 2 | 5 ✅ |
| `verify-edits.sh` | stderr + exit 2 | 3 ✅ |
| `config-change-notify.sh` v1 | stdout + exit 0 | **0** ❌ |

Conclusion: **`Stop` hooks surface stdout. `ConfigChange` does not. Probably same for `FileChanged`, `CwdChanged`, `InstructionsLoaded`, `TaskCreated`, etc. — anything that isn't `Stop`, `SessionStart`, or `UserPromptSubmit`.** The rule "text from stdout is added to the assistant's context" is only documented for a few specific events, and it silently does nothing for the rest.

**The fix (v2 ConfigChange, shipped same day):** switch to `exit 2 + stderr + hash-dedup`. Stderr + exit 2 is the channel that empirically surfaces (proven across 3 separate hooks). Hash-dedup is needed because exit 2 on every firing would wedge every session at startup when the hook fires on unchanged content.

**How to apply — the test recipe:**

Before declaring any new hook "done," run:
```bash
# Substitute a distinctive phrase from your hook's output
grep -l "MY_HOOK_BANNER_TEXT" ~/.claude/projects/-Users-tompryor-Broadwayscore/*.jsonl | wc -l
```

If the count is 0 after the hook has been active for a few real sessions — the output is NOT reaching the assistant. Fix by switching channels.

If you don't have days of real session data, simulate a live firing by invoking the hook through Claude Code's actual event pipeline (not a direct `bash hook.sh` invocation) and then grep your OWN session's transcript. Direct bash invocations bypass the harness, so they tell you the script is correct but nothing about surfacing.

**Known channels that work (2026-04-11):**
- `Stop` hooks: stdout + exit 0 → surfaces
- `Stop` hooks: stderr + exit 2 → surfaces (as block message)
- `PreToolUse` hooks: stderr + exit 2 → surfaces (as denial reason)
- `SessionStart` hooks: stdout + exit 0 → surfaces (as context injection)

**Known channels that do NOT work:**
- `ConfigChange`: stdout + exit 0 → DISCARDED (measured)
- By extension, probably `FileChanged`, `CwdChanged`, `InstructionsLoaded`, `TaskCreated`, `TaskCompleted` — all use stderr + exit 2 until proven otherwise.
