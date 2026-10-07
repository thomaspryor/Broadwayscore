---
name: feedback-in-review-pile-is-gate-manufactured
description: "Linear \"In Review\" cards pile up because their acceptance command names a file that never existed, so the Done gate can never pass; reconcile-landed-but-open.js already triages them and is wired to nothing"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 25b824dc-352c-4cbe-a88f-94763f2ddbd9
  modified: 2026-09-15T16:38:08.788Z
---

Before triaging a Linear backlog by hand, run the two detectors that already
exist and are wired into **no workflow**:

- `node scripts/reconcile-landed-but-open.js --json` — filters on
  `state.type === 'started'`, which is **both** `In Progress` and `In Review`,
  and requires all four of: a `linear-BRO-<n>-` merge commit on origin/main, no
  live dispatch/lease, a terminal `job-done` ledger event, and the card's own
  acceptance command re-run green against a fresh origin/main. Measured
  2026-09-15: 262 started issues scanned, 65 closable.
- `node scripts/audit-card-verifiability.js --source linear --limit 400` —
  already computes `missingCheckPaths`. Measured same day: 67 board-wide.

**Why the pile exists, which is not "nobody looks":** `enrich-card-acceptance.js`
had an LLM draft acceptance commands for ~84 legacy cards and validated only
that the drafted path's **parent directory** existed, never the file. Of 120
`In Review` cards, 47 acceptance commands failed — **40 named a test file that
has never existed anywhere on origin/main**, 6 named the wrong directory, 1 the
wrong runner (`node --test` where the test imports TS via `@/`, needs
`npx tsx --test`). When the worker then reports `--status=done`, the gate
refuses and `scripts/linear-session.js:246-250` **leaves the issue in its
current state** — so a correct, finished session parks in `In Review` forever.

**A green acceptance command is not sufficient to close.** BRO-2706 passed all
four reconciler signals while its defect was live in production CI, because its
check is a ratchet the bug walks past — the card says so in its own header.
Read the card's most recent comments for a post-work contradiction
("STILL HAPPENING", a dated recurrence) before closing on automation alone.

**Why:** ten minutes of running these two commands replaces days of hand
triage, and the phantom-command class means a card can be un-closable by
construction — no amount of re-doing the work will ever close it.

**How to apply:** run both detectors first; treat a `missingCheckPaths` hit as
"correct the command", not "redo the work"; post the corrected command as a
`VERIFY: <cmd>` comment, since `linear-brain.js update` cannot edit a
description. To see the pile at any time: `node scripts/bsc-in-review.js`
(`--all` for every row); it also renders as the "Review queue" block in the
7:30am digest via `scripts/lib/in-review-backlog.js`. Systemic findings about
this class go on BRO-3037, not new cards — see [[notion-brain-workflow]].
