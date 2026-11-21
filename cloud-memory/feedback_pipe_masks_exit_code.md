---
name: Pipe masks process.exit code
description: `node script.js | grep` returns grep's exit code, not node's. Use `set -o pipefail` or redirect, not pipe, when verifying exit 1 breach signals.
type: feedback
originSessionId: f0a48ef0-6fe0-4d83-919f-0d6df8b5922d
---
`node script.js | grep ...` returns grep's exit code (usually 0 if it matched), not node's. Shipping a `process.exit(1)` on breach and then "verifying" it via `node ... | tail -N` tells you nothing about whether the script actually exited 1.

**Why:** Caught during /ship-check verification of audit-opening-night-coverage.js tier-1 floor alert (2026-04-20). Floor breach was correctly detecting but four runs of `node ... | tail -30` all showed `exit=0`. Only `set -o pipefail; node ... > /tmp/out.txt; echo $?` revealed the true exit 1.

**How to apply:**
- When verifying a CI breach signal (any `process.exit(1)` or non-zero exit), either:
  - `set -o pipefail; node script.js | tail -N; echo "EXIT=$?"` — pipefail makes $? reflect earliest failure
  - `node script.js > /tmp/out.txt 2>&1; echo "EXIT=$?"; tail -N /tmp/out.txt` — no pipe at all
- Never trust `node ... | grep/tail/head ; echo $?` for exit-code checks. It lies silently.
- Same trap applies to `&&` chains: `node ... && echo ok` shows "ok" suppressed if node exits 0 but masks nothing; `node ... ; echo $?` is the safe read.
