---
name: feedback_linear_done_gate_no_pr_workflow
description: "linear-session.js report --status=done gate only recognizes PR-EVIDENCE URLs or a safe-form VERIFY command matching the issue's own acceptance criteria — neither fits this repo's standard direct-worktree-merge-to-main workflow (no GitHub PR) cleanly; use --force with a substantive reason."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 513fd962-c78a-43f0-bd20-8541c7224a24
  modified: 2026-09-08T14:47:27.691Z
---

Hit 2026-09-08 (BRO-3047 session): after merging a worktree branch straight to `main` via `scripts/merge-worktree-to-main.sh` (this repo's standard flow per CLAUDE.md — no GitHub PR involved), `node scripts/linear-session.js report --issue=X --status=done` was refused (exit 5, `doneGateRefused: true`) even with a real `--verification` string citing tests run and a live repro. The gate only accepts two done-evidence shapes: (1) a `PR-EVIDENCE: merged deployed checked (<url>)` line — doesn't exist, there's no PR; (2) a "safe-form" command matched against the issue's OWN `## Acceptance criteria` text — if that text contains a placeholder like `node -e "..."` (a literal ellipsis, never meant to be run), the gate extracts it as "first candidate" and fails validation on it, ignoring your `--verification` prose entirely.

**Why:** the gate re-parses the Linear issue's stored description/comments for acceptance-criteria commands rather than trusting the reporting session's own `--verification` text — by design, so a session can't just assert "trust me". But it has no third path for "direct-merge, no PR, verified via a battery of real commands this session".

**How to apply:** don't fight the gate repeatedully rewording `--verification` — check the refusal message's "first candidate" line once to see what it extracted from the issue text; if it's a genuine placeholder (not a real runnable command), the safe-form path is a dead end for this issue. Use `node scripts/linear-session.js report ... --force="<reason ≥10 chars>"` with a reason that names the actual verification performed (tests run, live repro, merge/content-survival check) — this is honest, not a bypass of real verification, since the gate's two hard-coded evidence shapes don't cover this repo's no-PR merge pattern. Consider filing a Notion/Linear card for a third done-evidence shape (e.g. a `MERGED: <sha> verified on origin/main` line) if this recurs often enough to be worth the gate-code change.
