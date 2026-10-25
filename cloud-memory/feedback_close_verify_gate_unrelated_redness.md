---
name: feedback_close_verify_gate_unrelated_redness
description: "notion-brain update --status Done can refuse with \"cannot close\" because the card's own verifyCmd fails on UNRELATED trunk redness, not your fix — investigate before assuming your work is broken."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ee98738a-fe92-40da-addc-c4b5c765998f
  modified: 2026-08-18T01:49:09.583Z
---

`node scripts/notion-brain.js update <id> --status Done` runs the card's dispatch-time `verifyCmd` (from `data/audit/dispatch-ledger.jsonl`) against a **fresh detached worktree at origin/main** (`scripts/lib/close-time-verify.js` + `acceptance-check-core.js`) and refuses to close on FAIL. When the verifyCmd is broad (e.g. bare `node scripts/validate-data.js`, common per CLAUDE.md rule 3), a FAIL does not mean your specific fix regressed — it means *something* in that command's full output failed, which can be a totally different, unrelated bug that landed on main from a concurrent session between your merge and your close attempt.

**Why:** Hit this 2026-08-17 (task #1736, white-rabbit-red-rabbit). My fix was verified clean (0 occurrences of my target error class), but `--status Done` refused because `validate-data.js` also failed a `[domain-collision]` check (`heraldscotland.com` claimed by two outlets) that a different concurrent merge introduced minutes earlier — nothing to do with my change.

**How to apply:** Before assuming your fix broke something, reproduce the close-verify gate's exact check yourself: `git worktree add --detach /tmp/check origin/main`, copy `data/*.json` flat files the same way `prepareCheckWorkdir` does (`scripts/lib/autonomous-checks.js`; NOTE it never copies `data/review-texts/` — see `[[project_close_verify_review_texts_gap]]`), then run the verifyCmd and read the FULL error list, not just the first lines the CLI truncates. If the failure is a different error class than what you fixed: (1) confirm your own class is genuinely gone, (2) card + auto-dispatch the unrelated regression as its own P0/P1 (don't fix it inline — scope creep), (3) close your own card with `--force "<reason citing the unrelated card>"`. Don't force-close without first citing evidence (grep/read) that the failure is genuinely unrelated — the gate exists to catch exactly the "I claimed Done while red" pattern, and a lazy force bypasses that on a real regression too.
