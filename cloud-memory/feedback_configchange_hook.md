---
name: ConfigChange hook installed — auto-warns on external config modifications
description: "Watches skills/user_settings/shows.json; use exit 2 + stderr."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
archived: true
---
**What it does (v2, 2026-04-11):** When an external process modifies a config file and the content hash actually changes, `~/.claude/hooks/config-change-notify.sh` blocks the session via `exit 2 + stderr` and surfaces a warning showing the old/new SHA-256 hash prefixes. The matcher is narrowed to `skills|user_settings`.

**Empirical finding that forced the v1 → v2 rewrite:**
v1 used `stdout + exit 0` on the theory that stdout surfaces to the assistant the same way `session-stop.sh`'s does. Measured across 22 real sessions with 45 firings on 2026-04-11: **ConfigChange stdout-on-exit-0 is SILENTLY DISCARDED.** None of those 22 sessions ever saw the warning in their transcripts. By contrast, the same grep on other hooks shows: `session-stop.sh` stdout → 35 sessions saw it; `verify-edits.sh` exit 2 → 3 sessions saw it; `notion-mcp-block.sh` exit 2 → 5 sessions saw it. Conclusion: Stop hooks surface stdout, ConfigChange does not. The /second-opinion reviewer who originally recommended "match session-stop.sh:52-59 pattern" didn't know this empirically, and neither did I. **Lesson: when a hook event's stdout-surfacing behavior isn't explicitly documented, measure it against real transcripts before trusting it.**

**Why v2 needs hash-dedup, not just exit 2:**
ConfigChange fires ~2x per session at startup (Claude Code reads settings.json and one or more skill files). Plain exit 2 on every firing would wedge every session at startup. Hash-dedup makes the hook silent when content hasn't actually changed — so startup reads (which don't change content) stay silent, and only real external content changes trigger the warning.

**How hash-dedup works:**
1. On every firing, compute the file's SHA-256 and write it to `~/.claude/config-change-state.json` (a flat JSON map: `{file_path: hash}`)
2. Compare current hash to the previously recorded hash for that file
3. **Decision logic:**
   - Current file missing/unreadable → silent (could be rename-in-progress)
   - No prior hash (first firing for this file) → record baseline, silent
   - Hashes match → silent (probably a startup read)
   - Hashes differ → **exit 2 + stderr banner** showing old/new hash prefixes
4. Audit log (`~/.claude/audit-config-changes.jsonl`) records every firing regardless of whether we warn, with both hashes for forensics

**v2 verification (6/6 test cases + live E2E):**
- 1a: first firing on new file → silent, state recorded ✓
- 1b: state file contains correct hash ✓
- 2: repeat firing on same content → silent ✓
- 3: content changed → **exit 2 + banner** ✓
- 4: after change, hash re-recorded → subsequent firings silent ✓
- 5: malformed JSON → silent ✓
- 6: file missing → silent (not a false positive) ✓
- **Live E2E:** modified `~/.claude/settings.json` with `jq '. + {_test_marker: true}'`, fired hook → exit 2 with banner showing `was=93e6673e82f5 now=ba9b74f170e9`. Reverted cleanly afterward.

**Still-open question — will v2 wedge Claude's own Edit/Write to settings.json or skill files?**
With hash-dedup, the answer depends on whether Claude's Edit/Write actually modifies the file content OR just touches mtime. If it's a real content edit, v2 will fire with exit 2 and wedge the next turn. Mitigation: after Claude edits its own config, immediately re-prime the state file (bash one-liner calling the hook) to re-baseline. We should observe this and either:
- (a) Accept the occasional self-wedge and document the "reprime after self-edit" recipe
- (b) Add detection: if the previous tool call was Edit/Write to this file, skip the warning (hard to implement from the hook — requires reading the transcript)
- (c) Use a sentinel file approach: Claude's own edits set `/tmp/.claude-self-edit-ok` which the hook checks

For now we observe.

**Primed state (2026-04-11):**
After v2 ship, state file primed with current hashes for:
- `~/.claude/settings.json`
- `~/.claude/commands/notion-feed-me.md`
- `~/Broadwayscore/.claude/settings.local.json`
Other files will get their baseline recorded on first firing and warn only on subsequent real changes.

**Test fixtures (persistent, not /tmp):**
`~/.claude/hooks/tests/configchange/` — 8 fixtures covering all 5 matcher source values + empty JSON + malformed JSON + `tool_input.file_path` fallback. Re-runnable via `bash /tmp/run-cc-tests.sh` (write the runner from this memory or the Notion card if /tmp got cleared). All 8 pass.

**Audit log (JSONL, append-only):**
`~/.claude/audit-config-changes.jsonl`. Each event = one line: `{ts, session_id, source, file_path}`. Useful for forensics if a regression appears. **No rotation yet** — if the file grows past a few thousand lines, add a logrotate rule or rewrite to keep last 1000 entries.

**Field-name fallback chain:**
The hook reads `.source // .config_source // "unknown"` and `.file_path // .tool_input.file_path // .path // "unknown"` with empty-string normalization, because the exact ConfigChange stdin shape isn't 100% documented and may evolve. If a future Claude Code release moves the field name, the fallback chain catches it.

**How this addresses the user's pain:**
Replaces the manual rule "always git diff after a hook runs" with automatic detection. The rule lived in CLAUDE.md and several memory entries but was forgotten by sessions. Now the hook fires automatically and the assistant sees the warning in its next turn without needing to remember.

**Verification status (2026-04-10):**
- ✅ Hook script syntax-checked (`bash -n`)
- ✅ All 8 fixtures pass (5 source values + 3 edge cases)
- ✅ Audit log writes correctly (JSONL, 6 entries from the 6 non-silent fixtures)
- ✅ settings.json validates clean (`jq .`)
- ✅ Matcher entry present in settings.json: `"skills|user_settings"`
- ⚠️ Live in-harness verification deferred to next session (hooks load at session start). On the next session, the first edit to `~/.claude/commands/*.md` or `~/.claude/settings.json` will reveal whether Claude's own edits trigger the hook. Update this memory with the result.

**Key files:**
- `~/.claude/hooks/config-change-notify.sh` — the hook
- `~/.claude/hooks/tests/configchange/*.json` — 8 test fixtures
- `~/.claude/settings.json` — wiring (Stop block, after verify-edits and session-stop)
- `~/.claude/audit-config-changes.jsonl` — runtime audit log
