---
name: workflow_dispatch runs can wedge at Checkout repository
description: manually-dispatched GHA runs can sit queued at the first step for 40+ min even with low total concurrent job count; cancel + immediately re-dispatch clears it
type: feedback
originSessionId: 145addcb-26fc-405b-9fc3-bd3f2a1e160b
modified: 2026-08-04T20:38:58.662Z
---
4 of 17 `gh workflow run llm-ensemble-score.yml` dispatches (task #1017, 2026-08-04) sat "Checkout repository: in_progress" for 45+ minutes while 13 sibling dispatches (same workflow, distinct `rescore_reason` concurrency groups, launched in the same loop) completed normally in a few minutes each. Total account-wide in-progress run count was only ~13 at the time — well under any published GitHub-hosted runner concurrency cap, so this isn't simple queue depth.

**How to apply:** If a `workflow_dispatch` run shows its first step (`Checkout repository`) still `in_progress` after ~15-20 minutes with no later step ever starting, don't keep waiting — `gh run cancel <id>` and re-dispatch the same job immediately. All 4 wedged runs in this incident succeeded normally on the retry. Don't burn a long `wait-for-run.sh` budget on a run that hasn't moved off step 1 — check the specific step (`gh run view <id> --json jobs`), not just overall `status`.
