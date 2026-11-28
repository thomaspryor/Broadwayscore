---
name: audit-scripts-gitignored-ledger-worktree
description: "Any script reading data/audit/*.jsonl (gitignored) must refuse, not guess, when run from a worktree where the file doesn't exist — verify before trusting its output."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5714cc25-f6c5-47a3-9545-ac9f837393da
  modified: 2026-08-16T20:51:06.907Z
---

**Rule:** Before trusting the output of any audit/reconciliation script that reads `data/audit/*.jsonl` (dispatch-ledger.jsonl, reconcile-report.jsonl, etc. — all gitignored, so absent by construction in a git worktree), check whether it distinguishes "file unreadable" from "file says X". A helper that returns `null` for unreadable and `[]`/`Set()` for "empty but real" is doing this correctly (see `dispatchedTaskIds()` in `scripts/audit-archived-in-progress.js`) — but a CALLER that does `helperFn(...) || new Set()` silently collapses both cases into "empty", which reads as "confirmed nothing" instead of "cannot answer".

**Why:** Built `scripts/audit-orphan-inprogress.js` (task #1705) in a worktree, called `dispatchedTaskIds(REPO)` (returns `null` when the ledger can't be read) with a `|| new Set()` fallback. Ran the tool for real from that worktree — every task looked "never dispatched" because the ledger genuinely doesn't exist there, and 3 real tasks with actual dispatch history got wrongly reclaimed to LOST/pending and their Notion cards flipped to "Not started", inviting a redo of already-attempted work. An independent adversarial ship-check review caught it before it went unnoticed. `audit-archived-in-progress.js`'s own docstring already states the principle ("absent input must read as 'cannot answer', never as 'answer is zero'") — the bug was not knowing the principle, it was not applying it at every call site.

**How to apply:** Writing or reviewing a script that reads a gitignored `data/audit/*.jsonl` file (directly or via a shared helper): (1) check what the reader returns when the file is missing — if it's the same shape as "found but empty", that's the bug; (2) if the caller can't tell the difference, make it refuse to run entirely (exit 2, matching `audit-archived-in-progress.js main()`'s pattern) rather than silently proceeding on a guess; (3) when actually RUNNING such a script for real effect (not just testing the code), run it from the main checkout, not a worktree, unless you've confirmed step 1/2 are handled.
