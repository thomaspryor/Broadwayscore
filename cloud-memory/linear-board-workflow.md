---
name: linear-board-workflow
description: "The board is Linear (Notion retired 2026-08). Card lifecycle for every session: create/claim at start, Outcome comment + close at end, dispatch P0/P1."
metadata:
  node_type: memory
  type: feedback
---

## Linear is the board (CLAUDE.md §6)

Notion is retired: `notion-brain.js create` exits 6, the mirror froze 2026-08-20, and a
Notion update no longer counts as a close-out in any gate (BRO-4274). Never use it.

**Session start** (one of):
- New work: `node scripts/linear-brain.js create "<title>" --dispatch|--park "<reason>" --notes "...## Acceptance criteria\n<safe-form command>"`. Output the URL.
- Dispatched onto an existing issue: `node scripts/linear-session.js claim --issue=BRO-N`.
- Pick the worker model at filing with `--model opus|sonnet` (stamps a `Model:` line the Mac dispatcher reads). Opus: multi-file, architectural, adversarial debugging. Sonnet: mechanical, single-file, data fixes. Opus picks count toward the 6-a-day Opus cap; a retried card escalates to Opus whatever the line says. Omitted: Opus for P0s and retries, else Sonnet.
Keep the BRO-N from that output; it is the session's card (there is no "list In Progress" search).

**During:** new discoveries get their own issue (`linear-brain.js create ... --park`), batched, only if not fixable now. `linear-brain.js find "<phrase>"` returns the first open issue matching a title/body phrase (dedup check before filing).

**Session end:**
- Outcome + Key Files as a comment, then close: `node scripts/linear-brain.js update BRO-N --state Done --comment "<Outcome>\nPR-EVIDENCE: merged deployed checked (<commit or PR URL>)"`.
- Claimed issue: `node scripts/linear-session.js report --issue=BRO-N --status=done --summary="..." --key-files="a,b" --verification="..."`.
- Pause / RECHECK-AFTER: Linear has no Paused state. `linear-session.js report --issue=BRO-N --status=paused --summary="RECHECK-AFTER: YYYY-MM-DD ..."` (sets Backlog), or `linear-brain.js update BRO-N --state Backlog --comment "..."`.
- Done is gated (exit 5) without `PR-EVIDENCE:` or a safe-form `VERIFY:` / `## Acceptance criteria` command. A refused update is not a close-out; the Stop hook (NOWRAPUP) checks for a successful one after the last work.

**P0/P1:** `--dispatch` does not launch. Run `node scripts/linear-next.js --id BRO-N` (Mac) and report `DISPATCHED:`. Cloud cannot launch cmux workers and `create_session` is denied: add a `START-NOW:` line to the card's notes so the hourly cloud worker takes it first.

**Linear down:** warn, continue untracked, print the Outcome text in chat. Do NOT fall back to Notion.
