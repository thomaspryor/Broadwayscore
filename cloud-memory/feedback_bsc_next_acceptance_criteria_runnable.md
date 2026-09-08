---
name: feedback_bsc_next_acceptance_criteria_runnable
description: "bsc-next.js refuses to dispatch a card whose acceptance criteria is prose-only — it needs a backticked, safe-form runnable command"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bf0552d2-f9f2-4725-a946-b40c33e11d49
  modified: 2026-09-08T04:51:25.029Z
---

When creating a Notion card meant for `bsc-next.js --id N` dispatch, the "## Acceptance criteria" section must contain a backticked command in one of the safe forms `scripts/lib/verify-gate.js` accepts (`node --test <path>.test.mjs`, `npx tsc --noEmit`, `npx next lint`, `test -f <path>`). Prose-only criteria ("the two flagged tests are refactored...") gets rejected at dispatch time with "no runnable verify command (acceptance criteria names no runnable command (prose only))" — even though the card creates fine.

**Why:** the nightly acceptance recheck (`scripts/autonomous-acceptance-recheck.js`) can only verify Done work by re-running a captured command; a card with no runnable criteria has nothing for it to check, so `bsc-next` refuses the launch up front rather than let it silently become unverifiable later.

**How to apply:** write the acceptance criteria as backticked command(s) FIRST, then add any prose framing around it, before calling `bsc-next --id N`. If the outcome genuinely can't be machine-checked, add `VERIFY: owner-judgment` to the card instead of fighting the gate, or dispatch with `--allow-unverifiable` (recorded in the ledger, recheck lists it as unverifiable). Confirmed 2026-08-13: two cards created back-to-back both needed this fix before `bsc-next` would launch them.

**Same gate blocks `linear-session.js report --status=done` too, not just `bsc-next` dispatch (confirmed 2026-09-08, BRO-3051):** `SAFE_CHECK_FORMS` in `scripts/lib/autonomous-triage-core.js` matches the LITERAL command text, not what it resolves to — `npm run test:one scripts/lib/foo.test.mjs` is a real, runnable, backticked command (not prose) but still gets refused with "no acceptance-criteria command passed safe-form validation", because only the raw `node --test <path>.test.mjs` / `npx tsx --test <path>.test.mjs` forms are recognized, never an npm-script wrapper around them. Fix: when a Linear issue's own acceptance criteria uses `npm run test:one X`, don't fight it — check what that npm script actually invokes (`npm run` prints it, or read `package.json`), then pass the raw form as `--verification` (and ideally fix the VERIFY line on the issue itself) — e.g. `node --test scripts/lib/alert-ledger-commit-check.test.mjs` in place of `npm run test:one scripts/lib/alert-ledger-commit-check.test.mjs`.
