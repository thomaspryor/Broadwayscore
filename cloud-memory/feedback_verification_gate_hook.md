---
name: Verification gate is now hook-enforced — you can't claim "done" without running the code
description: "Stop hook blocks \"done\" after edits unless a qualifying Bash ran. Bypass: NO-VERIFY:."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
---
**Rule:** After editing any code file (`.js`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.py`, `.sh`, `.rb`, `.go`), you cannot stop the session until you have either run the code or explicitly disclaimed verification. This is enforced by `~/.claude/hooks/verify-edits.sh` (a Stop hook), not just a memory rule.

**Why:** Sessions repeatedly edited code, claimed "done", and only when the user asked "is this fully tested?" did they admit "honestly no, let me check" — and then almost always found 1–3 bugs. The pattern was: skim the diff, declare success, return control. The user had to be the verification gate. The hook moves the gate into the harness so the user doesn't have to remember.

**How the hook works:**
1. On every Stop event, the hook walks the session transcript backward to find the most recent Edit/Write/NotebookEdit to a code file (extensions above).
2. If found, it scans forward looking for one of:
   - A Bash command whose `command` string contains the edited file's basename or full path
   - A Bash command matching a recognized verification pattern: `tsc`, `next build`, `npm test`, `vitest`, `jest`, `pytest`, `eslint`, `next lint`, `playwright`, `curl`, `gh run`, `gh workflow`, `node -e`, `python -c`, `cargo test`, `go test`, etc.
   - The literal string `NO-VERIFY:` in any subsequent assistant text (the documented override)
3. If none of the above appears since the last code edit → exits 2 with a stderr block message. Claude is forced to continue and actually run the code.

**Exempt paths (no verification needed):**
- `/memory/` — auto-memory entries (.md, but belt-and-suspenders)
- `/CLAUDE.md`, `/MEMORY.md` — markdown rule files
- `/.github/workflows/` — CI workflows, can only run on push not locally
- `/node_modules/` — vendored deps
- `/.claude/projects/`, `/.claude/file-history/`, `/.claude/plans/`, `/.claude/sessions/`, `/.claude/cache/`, `/.claude/backups/`, `/.claude/downloads/` — internal Claude Code state, not user-editable code
- Anything that doesn't end in a code extension (`.md`, `.json`, `.yml`, etc. — handled by CODE_EXTS filter)

**NOT exempt (deliberately tightened 2026-04-10):**
- `/.claude/hooks/*.sh` — hook scripts must be tested before stopping. Originally exempt under blanket `/.claude/`, which left a gap where the verification gate couldn't enforce changes to itself. Now any edit to a hook script requires either `bash -n hook.sh`, running the script's fixtures, or any Bash command containing the hook's basename.
- `/.claude/skills/**/*.{sh,py,js,ts}` — skill executables (markdown skill files are still skipped because `.md` isn't in CODE_EXTS).
- `/.claude/plugins/**/*.{js,ts,sh,py}` — plugin code.
- `/.claude/commands/*.md` — naturally skipped because `.md` isn't in CODE_EXTS, but no longer in the exempt list either. If you want enforcement on skill prompt files, add `.md` to CODE_EXTS — but that's overbroad.

**Bypass — `NO-VERIFY: <reason>`:**
For genuinely untestable changes (comment-only edits, pure docs in a code file, deleting dead code with no callers), include `NO-VERIFY: <one-sentence reason>` in your final message text. The hook scans subsequent assistant text for this literal string and passes if found. Use sparingly — most code changes should actually be run.

**Gameability:** A bare `ls` or `echo` after the edit will NOT pass. The Bash command must touch the file by name OR run a recognized verification tool. Tightening the qualifying-command list further is OK if new gaming patterns emerge.

**How to apply:**
- Default workflow: edit code → run it (or `tsc`/`next build`/test) → read the output → THEN write the final message.
- If you find yourself thinking "the change is small, I don't need to run it," you're wrong. Run it.
- The block fires once per stop event. Once you've run the qualifying command, the next stop passes naturally.
- Test fixtures are in `/tmp/verify-test/` (rebuildable from the test block in this hook's commit). Add a fixture for any new pattern you want covered.
