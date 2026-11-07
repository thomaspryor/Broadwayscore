---
name: memory-index-cap-enforced-at-write
description: "MEMORY.md index is hard-capped at write time (memory-index-cap-guard.sh) — why it kept regrowing, line-vs-byte reality, how to add an entry when full"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 10f198fd-e975-405a-bca5-a7a0b7a30d1d
---

MEMORY.md (the always-on memory index) is now hard-enforced at WRITE time by a PreToolUse hook, `~/.claude/hooks/memory-index-cap-guard.sh` (registered in `~/.claude/settings.json`). Caps: **180 lines, 20000 bytes**. The hook blocks any Edit/Write that would grow the file *past* cap; shrinking or same-size edits are always allowed, so you can never get wedged — but once full, the only way to add is to remove/merge.

**Why this exists (the root cause prior sessions kept missing).** The index regrew to 206 lines / 23KB by 2026-06-05 despite a SessionStart warning that had flagged it for weeks. The failure was structural, not lazy sessions: **additions are automatic** (the harness memory instruction + CLAUDE.md §16 tell every session to append an index line on each save) while **removals are manual** (a discretionary curation pass). Auto-add / manual-remove grows without bound. Every prior "fix" was a one-time curation pass, which regrew within days because the asymmetry was untouched. The write-time guard fixes the asymmetry itself.

**Lines vs bytes — both bind, lines are the data-loss one.** The user's recollection that "we switched to size-based so long lines couldn't game the line cap" is true for the *hook warning*, but the **harness itself hard-truncates the index at ~200 lines** regardless of byte size — entries past ~200 load but are silently invisible. So lines are not a soft, gameable metric: packing content into fewer long lines just loses more per truncated line. The 180-line cap leaves a 20-line safety margin under the harness cut. The 20KB byte cap is the always-on token cost (~5K tokens). Keep `session-start.sh` `MEMORY_BYTES_LIMIT` in sync with the guard.

**Why dropping an index line is safe.** The index is already a curated SUBSET — 450+ memory files exist on disk; only ~165 are indexed. Unindexed memories are still surfaced on demand by recall (that's how the other ~285 function). So dropping/merging an index line does NOT delete the memory — the file stays and remains recall-able. Only cross-cutting rules that apply to MOST sessions earn an always-on index line.

**How to apply when you hit the block:**
- Most new memories: write the `feedback_*.md` file with a good `description:` frontmatter line and DON'T add an index line. Recall handles it.
- Genuinely always-on: in the same edit, merge a narrow sibling into a related line (keep its `[[link]]`) or drop the lowest-value entry.
- Intentional structural rewrite (the curation itself): put `MEMORY-CAP-OK` in the content to bypass.
- `scripts/rebuild-memory-index.js` bypasses the guard (writes via fs, not Edit/Write) and regenerates verbose auto-gen lines that destroy curated short hooks — don't run it to overwrite; it's print-to-stdout/manual only.
