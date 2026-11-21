---
name: feedback-isolated-worktree-verify-artifact-must-be-committed
description: "dispatched bsc-next --headless sessions run in an isolated per-job git worktree; any fix artifact that close-time-verify.js or a card's acceptance command needs to see must be committed+pushed, never gitignored or left local-only"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6b766938-7dc0-4096-8f14-9e2ff3fd87eb
  modified: 2026-08-11T23:50:41.373Z
---

A headless session dispatched via `bsc-next.js --id N --headless` runs in an isolated, ephemeral per-job git worktree (`scripts/lib/bsc-runner.js`), completely separate from the main checkout. `close-time-verify.js` (the gate deciding whether a card may move to Done) and the initial dispatch-time verify gate both run the card's acceptance command against a **fresh checkout of origin/main** (`scripts/lib/acceptance-check-core.js`'s `makeFreshCheckout`/`runVerify`), never against the dispatched session's own worktree.

**Why:** designing task #1225 (Digest-autofix S6 daily canary), the first version had a dispatched session `touch` a marker file that was gitignored — a perfectly successful fix, verified locally inside the job's own worktree, could never be proven, because the file never existed anywhere `origin/main`-based verification could see it. Caught by an adversarial Codex review before shipping, not by any automated check — there is no lint/CI gate for this class yet.

**How to apply:** before designing any feature where a dispatched session's own file-write is the proof of success (synthetic canaries, self-healing probes, "touch this file" acceptance criteria), ask: does anything check this artifact against `origin/main`? If yes, the artifact MUST be a tracked, committed file — never gitignored, and the card's instructions must explicitly say to commit+push, not just create the file. Prefer git-based verification (`git fetch` + `git cat-file -e origin/main:<path>`, or reuse `acceptance-check-core.js`'s `makeFreshCheckout`/`runVerify`) over a local `fs.existsSync` check in code that runs on the dispatch host, which will never see artifacts left in a torn-down job worktree.
