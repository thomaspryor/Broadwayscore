---
name: feedback_bsc_next_acceptance_criteria_runnable
description: "bsc-next.js refuses to dispatch a card whose acceptance criteria is prose-only — it needs a backticked, safe-form runnable command"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bf0552d2-f9f2-4725-a946-b40c33e11d49
  modified: 2026-08-14T00:03:16.687Z
---

When creating a Notion card meant for `bsc-next.js --id N` dispatch, the "## Acceptance criteria" section must contain a backticked command in one of the safe forms `scripts/lib/verify-gate.js` accepts (`node --test <path>.test.mjs`, `npx tsc --noEmit`, `npx next lint`, `test -f <path>`). Prose-only criteria ("the two flagged tests are refactored...") gets rejected at dispatch time with "no runnable verify command (acceptance criteria names no runnable command (prose only))" — even though the card creates fine.

**Why:** the nightly acceptance recheck (`scripts/autonomous-acceptance-recheck.js`) can only verify Done work by re-running a captured command; a card with no runnable criteria has nothing for it to check, so `bsc-next` refuses the launch up front rather than let it silently become unverifiable later.

**How to apply:** write the acceptance criteria as backticked command(s) FIRST, then add any prose framing around it, before calling `bsc-next --id N`. If the outcome genuinely can't be machine-checked, add `VERIFY: owner-judgment` to the card instead of fighting the gate, or dispatch with `--allow-unverifiable` (recorded in the ledger, recheck lists it as unverifiable). Confirmed 2026-08-13: two cards created back-to-back both needed this fix before `bsc-next` would launch them.
