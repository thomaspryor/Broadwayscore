---
name: notion-card-creates-duplicate-task
description: "Creating a P0/P1 Notion card mid-session auto-syncs a second, duplicate task-list entry alongside any TaskCreate you did yourself — check for and delete the dupe before dispatching, or you risk a double-dispatch on the same card."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: deda83f3-d43d-4c8b-8210-b40814853af5
  modified: 2026-08-15T13:20:14.085Z
---

2026-07-21 (card #240 wrap-up): created a Notion card via `notion-brain.js create` with Priority "P1 Next", then separately ran `TaskCreate` to add it to the shared task list so I could dispatch it with `bsc-next.js --id`. Some background sync (not something I invoked) ALSO mirrored the same Notion card into the task list as a second entry with the same Notion card ID embedded in its description — `TaskList` showed both #247 (mine, already in_progress after dispatch) and #248 (the auto-synced duplicate, still pending).

**Why:** per `memory/notion-brain-workflow.md`, "only P0/P1 cards mirror" from Notion into the task list. That sync ran independently of my manual `TaskCreate`, producing a second entry for the same underlying card. A later session (or bsc-next's own picker) could dispatch #248 without knowing #247 already claimed the work — a duplicate-dispatch collision.

**How to apply:**
1. After creating a P0/P1 Notion card AND a matching `TaskCreate` entry in the same session, run `TaskList` again before dispatching and check for a second task carrying the same Notion card ID in its description/metadata.
2. If found, `TaskUpdate` the auto-synced duplicate to `status: deleted` before (or right after) dispatching — don't leave both live.
3. This is a one-way risk: creating the Notion card first is what triggers the sync, so the duplicate always appears with a *higher* task number than the one you created manually. Check the newest task IDs first.

**2026-08-15 addendum (BRO-363):** `linear-next.js --headless` dispatched the same Linear issue as an already-in-progress cmux session (mine) — bsc-next's duplicate-dispatch guard didn't stop it since Linear dispatch is a separate entry point. Result: 2 full sessions independently root-caused and fixed the same bug in the same shared worktree in parallel (converged without conflict, but wasted a full session + left 3 near-duplicate Notion cards "In progress" that nobody closed). Before starting deep investigation on a Linear-dispatched card, `notion-brain.js search --text="<card keywords>"` for other in_progress cards on the same bug — don't rely on the dispatcher to have caught it.

Related: [[notion-brain-workflow]]
