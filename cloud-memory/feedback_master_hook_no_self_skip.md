---
name: master-hook-no-self-skip
description: "When mirroring a project .claude/hooks/*.sh to ~/.claude/hooks/ master, STRIP the self-skip preamble. The preamble (`if [ -f \"$HOME/.claude/hooks/$(basename $0)\" ]; then exit 0; fi`) is ONLY for project copies. If a master carries it, the master self-skips itself when called from settings.json → silent disable of every gate in that hook."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2fb98a03-86db-4013-a4fc-697f6958e83d
---

**Rule:** Project copies of hooks under `.claude/hooks/*.sh` carry a self-skip preamble that exits 0 when the user-level master at `~/.claude/hooks/<basename>` exists (to avoid double-fire on local CLI). **Master copies at `~/.claude/hooks/` MUST NOT carry this preamble.** If you mirror a project copy to the master location, strip the preamble block.

**Why:** Caught 2026-05-24 during /ship-check of the visual-qa gate. I copied `.claude/hooks/verify-edits.sh` (project) to `~/.claude/hooks/verify-edits.sh` (master) to make my new is_ui_edit branch active in this session. The copy included the self-skip preamble. When Claude Code invoked the master via `bash ~/.claude/hooks/verify-edits.sh`, the preamble tested `[ -f "$HOME/.claude/hooks/verify-edits.sh" ]` — that's the file currently running — found it true, exited 0. The master silently disabled itself for ~30 min, meaning the scoring gate, the shipcheck gate, AND my new visual-qa gate all stopped firing on every Stop event. Discovered when an E2E test (`echo {} | bash $HOOK`) returned exit 0 immediately with no gate logic running.

**How to apply:**
- When updating a hook, edit BOTH `.claude/hooks/<name>.sh` (project, with self-skip) AND `~/.claude/hooks/<name>.sh` (master, without self-skip).
- The strip pattern: `sed '/^# Self-skip/,/^fi$/d' project.sh > master.sh` (or sed line-range delete).
- Verify after mirroring: `echo '{}' | bash -x ~/.claude/hooks/<name>.sh 2>&1 | head -5` — if the trace ends with `+ exit 0` after the self-skip line, master is broken.
- Existing master hooks in `~/.claude/hooks/` (notion-create-block.sh, verify-edits.sh, design-system-lint.sh, etc.) DO NOT have the preamble — confirm via `head -10 ~/.claude/hooks/<name>.sh`. New mirrors should match that pattern.
- Better long-term: codegen master from project (one source of truth, automatic strip step), OR have project be a thin shim that `exec ~/.claude/hooks/<name>.sh` when present.

**See also:** [[local-preview-before-push]] (visual-qa gate that surfaced this), [[claude-config-sync]] (~/.claude is a git repo synced via claude-sync; reverting is `cd ~/.claude && git restore hooks/<name>.sh`).
