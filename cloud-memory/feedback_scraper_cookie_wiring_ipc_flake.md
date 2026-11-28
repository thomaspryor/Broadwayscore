---
name: scraper-cookie-wiring IPC flake
description: tests/unit/scraper-cookie-wiring.test.mjs fails intermittently in CI with "Unable to deserialize cloned data" — node.js test runner IPC bug, not a real assertion failure
type: feedback
originSessionId: 0c5a9a9a-3a8a-4631-9870-3de8d2120302
archived: true
---
tests/unit/scraper-cookie-wiring.test.mjs fails ~40% of CI runs with:
```
failureType: 'uncaughtException'
error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
code: 'ERR_TEST_FAILURE'
stack: #proccessRawBuffer (node:internal/test_runner/runner:358:20)
```

**Why:** Node.js test runner bug — worker-to-parent IPC structured-clone fails intermittently when many test files run in parallel. Not an actual test assertion failure. Runs clean 3/3 locally. Same code passed run 72361877470, failed runs 72323533258 + 72363401227 — no diff between runs.

**How to apply:**
- Do NOT treat this failure as caused by your session's changes. Check if prior main runs also hit it before chasing.
- Do NOT attempt to fix by editing the test unless you can reproduce locally with `for i in 1 10; do node --test tests/unit/scraper-cookie-wiring.test.mjs; done`.
- Re-dispatch Test Suite (`gh workflow run 227151982 --ref main`) — often passes on retry.
- Real root cause likely: Node version upgrade (newer node:test IPC is more stable) or parallelism change (`--test-concurrency=1`). Not worth fixing reactively.
