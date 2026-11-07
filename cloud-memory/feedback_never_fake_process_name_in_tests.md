---
name: feedback_never_fake_process_name_in_tests
description: "Never spawn a real OS process literally named a CLI binary (e.g. \"claude\") to fake liveness in a test — use dependency injection instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 11dd60dc-4446-4ffe-9036-fbd0dbcb8fe1
  modified: 2026-08-16T21:57:06.490Z
---

Never spawn a real OS subprocess literally named after a production binary (e.g. `claude`) to simulate "is this process alive" in a test. Use dependency injection (thread the liveness predicate as a parameter, same idiom as this codebase's existing `nowMs` threading in [[dispatch-attempts]]/dispatch-health.js) instead.

**Why:** In card #1454 (headless dispatch telemetry), a test needed to fake a live `bsc-runner.js` job holder so `pidLooksLikeClaude()` (which greps `ps -o command=` for `/claude/`) would see it as alive. A shebang script (`#!/bin/sh\nexec sleep 60`) named `claude` raced: the setup assertion saw "sh .../claude" and passed, but by the time `runJob()`'s own internal check ran microseconds later, the shell had already `exec`'d into `sleep 60` — no "claude" match — so `acquireLease()` read the holder as dead, **stole the "stale" lease, and `runJob()` proceeded to spawn a REAL claude-cli session** (~$0.23 real API cost, no lasting damage, caught only because the log file was manually inspected). A second attempt (a directly-executed binary literally named `claude`, no shell interpreter hop) got SIGKILLed outright by this sandbox's own process monitoring — the same class of danger from a different angle.

**How to apply:** Whenever a test needs to simulate "a real process is alive/named X" for a liveness check, add an injectable predicate to the function under test (e.g. `acquireLease(taskId, meta, {isAliveFn = realCheck} = {})`) rather than spawning anything that could pass for the real binary. This is strictly safer and faster (no subprocess, no timing race) and still exercises the real production control flow per CLAUDE.md rule 15 — only the OS-liveness *input* is swapped, not the logic being tested.
