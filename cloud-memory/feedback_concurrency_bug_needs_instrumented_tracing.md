---
name: feedback_concurrency_bug_needs_instrumented_tracing
description: "For file-based concurrency/race bugs, add hi-res trace instrumentation before proposing a fix — pure reasoning about interleavings is unreliable and can make things worse"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5a7cc44c-2300-4bd2-ab49-d27f95ed2dbd
  modified: 2026-08-05T00:12:05.145Z
---

For race conditions in cross-process file-lock code, add `process.hrtime.bigint()` trace logging to a debug harness and actually reproduce the failure BEFORE reasoning about a fix, not after.

**Why:** Fixing task #1024 (file-lock.js stale-break race, ~12% repro), the first fix attempt (post-rename re-verify) was reasoned through correctly and reduced failures to ~2%. The SECOND attempt (non-destructive hardlink snapshot) was *also* reasoned through carefully — and made things worse (~10% failure), because hardlinks keep a detached inode's content alive indefinitely, so a racer reading a "snapshot" could act on data that was already many generations stale. This is a subtle inode-semantics trap that pure reasoning missed twice. Only after building an instrumented harness (workers log `${hrtime} pid=X <event>` to a shared trace file, sorted post-hoc) did the actual interleaving become visible in one run, which then made the correct in-place-claim design obvious.

**How to apply:** When a race condition's repro rate is measurable (not one-off), don't iterate fix→test→fix on reasoning alone. Build a trace harness (each racer process appends timestamped events to a shared file) and capture ONE actual failing interleaving first. The real sequence of events is often not what careful reasoning predicts, especially with OS-level primitives (hardlinks, rename atomicity, inode lifecycle) that have counter-intuitive persistence semantics. See also [[feedback_ship_check_finds_real_bugs.md]] — for concurrency-critical fixes specifically, get an independent adversarial review (Codex) even after tests pass; two rounds of review here each caught a real residual TOCTOU window that 200+ passing test runs did not surface (probabilistic bugs can pass many runs and still be wrong).
