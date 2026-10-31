---
name: scripts-lib-ship-check-gate-requires-review-after-the-last-edit-not-once-per-session
description: "verify-edits.sh's BWSC gate checks the most recent edit specifically — a follow-up fix after ship-check ran needs its own fresh codex/ship-check pass."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 324bae60-c8e4-42c2-a1dc-2767f8dd57da
  modified: 2026-08-14T22:20:22.823Z
---

**Rule:** `~/.claude/hooks/verify-edits.sh`'s BWSC ship-check gate (for edits to `scripts/lib/` or `.github/workflows/`) checks whether a ship-check/codex/agent-review token appears AFTER the MOST RECENT edit to a gated file — not whether one ran anywhere earlier in the session. Running `/ship-check` once, then making a follow-up fix in response to that review's own findings, leaves the follow-up edit unreviewed and the hook blocks the Stop.

**Why:** Session 2026-08-14 (task #1529, outletOwnsUrlDomain path-aware fix): ran `/ship-check` → Codex found a real null-handling divergence in `scripts/lib/review-normalization.js` → fixed it (second edit to the same gated file) → ran unit tests + committed + merged + pushed, but never re-ran codex/ship-check on that second edit specifically. The Stop hook blocked with "edit to review-normalization.js without ship-check" even though ship-check HAD run earlier that session — the gate doesn't care about "earlier," only "after the last edit to this file."

**How to apply:** After any fix made in direct response to a review finding (Codex, ship-check subagent, second-opinion), if the fix itself touches `scripts/lib/` or `.github/workflows/`, run one more lightweight codex/agent pass targeting just that follow-up diff before ending the session — don't assume the original ship-check invocation covers it. A quick single-purpose codex prompt scoped to `git show <fix-commit>` is enough; it doesn't need to be a full `/ship-check` re-run. See [[feedback_verification_gate_hook.md]] for the general (non-BWSC) verify-edits mechanics this gate layers on top of.
