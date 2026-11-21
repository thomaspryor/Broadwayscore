---
name: feedback_tail_truncation_false_verification
description: "piping a verification command through `tail -N` can show the same trailing text whether it passed or failed — always grep for the actual pass/fail marker, never assume from tail alone"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07b104ac-1b9d-46e2-9972-635a9fc76885
  modified: 2026-07-26T20:51:00.644Z
---

Never trust `command | tail -N` as proof of success unless N is large enough to guarantee the pass/fail marker line is included, or you separately grep for that marker. Some scripts print identical trailing "how to fix this" tip text in both the success and failure branches (or the tip text is longer than N lines), so `tail -3` can show the same output either way.

**Why:** In the task #533/#545/#550 hasHelpFlag retrofit chain, I ran `node scripts/audit-help-flag-safety.js 2>&1 | tail -3` after a batch of fixes and read the generic "False positive? Add // hygiene-help-flag-ok..." tip line as confirmation of success. That tip text prints identically in the failure branch too — it's not a green/red signal, it's a fixed footer. I merged and pushed a batch to `main` believing it was clean; it actually had 13 real Rule A violations, breaking CI (test.yml's audit-help-flag-safety.js step) until caught by an explicit `grep -E "✅|🚨"` check in a later verification pass. Two consecutive batches were affected before I caught it.

**How to apply:** For any pass/fail-style CLI check, verify by grepping the actual status marker (✅/🚨, "PASS"/"FAIL", exit code via `echo $?`) — never infer status from a truncated tail of static/repeated text. When in doubt, run the full untruncated output at least once to see what the real success/failure lines look like before trusting a shortened form.
