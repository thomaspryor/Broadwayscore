---
name: feedback_visual_qa_dev_server_in_worktree
description: Running a local dev server in a worktree for /visual-qa needs symlink + backgrounding gotchas handled or it fails repeatedly
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1387cc88-25e2-4ef3-bf03-ed694296c587
---

UI edits are mandatory-worktree and UI changes are mandatory-/visual-qa, so nearly every UI change needs `npm run dev` running inside a fresh worktree. A fresh worktree branches from origin and has NO `node_modules`, NO `.env`, and empty (gitignored) `data/*.json` — so the dev server 500s on every data-backed page. Three gotchas, all hit on 2026-06-04 doing the Outlets footer link:

1. **Symlink-of-symlink breaks webpack's JSON loader.** The main checkout's `data/reviews.json` is itself a symlink into the private data repo. If you symlink the worktree's `data/reviews.json` → main's symlink, webpack follows the chain wrong and throws `Cannot parse JSON: Expected double-quoted property name at position 69`. Fix: point each worktree data symlink at the FULLY resolved real path — `ln -s "$(readlink -f main/data/x.json)" data/x.json`.
2. **Never symlink `.next` from the main checkout** into the worktree — it serves stale/wrong module resolution. Let the worktree build its own `.next`.
3. **`npm run dev &` inside a normal (foreground) Bash tool call gets reaped** when that call (or a later one) tears down its process group — the server dies between tool calls, so the next `curl`/screenshot gets `000`. Start it with `run_in_background: true` so it's properly detached, then screenshot in a separate call.

**Why:** lost ~15 min to repeated 500s and dead servers before diagnosing. **How to apply:** when setting up visual-qa in a worktree: symlink `node_modules` + `.env` from main, resolve each `data/*.json` to its final real path, do NOT symlink `.next`, start dev with `run_in_background: true`, then poll the port until 200 before driving Playwright. Clean up the dev-only symlinks before staging the commit. See [[feedback_local_preview_before_push]] and [[feedback_worktree_code_changes]].

4. **Set the FULL demo flag set, not just the one you're testing** — `NEXT_PUBLIC_FEATURES=userAccounts,showPageRedesign,showtimes`. Setting only `userAccounts` renders the LEGACY show-page hero (no ShowHeroRedesign), so you QA the wrong component entirely and the screenshots look plausibly real (2026-07-15: one wasted QA round — hero edits were invisible until showPageRedesign was added).
