---
name: feedback_codex_review_data_check_bail
description: "Codex CLI adversarial review bails entirely if npm run data:check fails, even for a scoped diff that never touches data/ — worktrees lack local data setup"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ff1b80e8-00dd-4c6c-b4ae-41046b77529b
  modified: 2026-07-24T16:48:56.292Z
---

Running `/ship-check`'s Codex adversarial-diff-review step from a worktree that has no local `data/*.json` setup (no `~/broadway-scorecard-data` clone) causes Codex to run `npm run data:check` on its own initiative (following CLAUDE.md's session-start convention), see it fail, and refuse to continue — even when the diff under review is scripts/workflow-only and never touches `data/`. It doesn't fall back to reviewing anyway; it just stops and reports the blocker.

**Why:** Codex has repo read access and treats CLAUDE.md's rules as binding for itself too, so a precondition meant for interactive coding sessions (not scoped reviews) short-circuits the review. Cost: one wasted Codex invocation (2026-07-24, #425 session).

**How to apply:** when Codex bails for this reason mid-ship-check, don't retry Codex — go straight to the `/ship-check` documented fallback (GPT-4o via `api.openai.com` with the same adversarial prompt + diff, reusing the reviewer-2 curl mechanics). Don't burn a second Codex call assuming it was a fluke. Related: [[feedback_visual_qa_dev_server_in_worktree]] (same root cause — worktrees start with no local data — different failure mode).
