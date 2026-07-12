---
name: GitHub Actions concurrency queue depth is 1
description: "Queue depth is 1 even with cancel-in-progress:false; use per-run groups."
type: feedback
originSessionId: 1ca7d6fd-fdf5-4664-9d80-02192bffb91b
archived: true
---
GitHub Actions concurrency groups with `cancel-in-progress: false` have a queue depth of 1. If a run is in-progress and a second run is queued (pending), a THIRD dispatch will cancel the queued run to take its place. This caused 30% of poller runs to be cancelled on Cats opening night (21/70).

**Why:** GitHub's documented behavior is "queue" but the queue only holds 1 pending run per group.

**How to apply:** For workflows that are dispatched frequently by an orchestrator, use per-run concurrency groups: `group: workflow-name-${{ github.run_id }}`. The orchestrator serializes by waiting on each poller run (`scripts/lib/wait-for-run.sh` since 2026-07-12) so same-market pollers don't overlap. Cross-market pollers (BW vs WE) can safely run in parallel — they work on different shows.
