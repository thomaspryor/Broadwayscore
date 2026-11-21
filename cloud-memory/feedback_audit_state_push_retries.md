---
name: Audit-state push retries — 3 is too few during contention
description: Solo-commit cron workflows that push state files to public main need 5+ retries; 3 retries lose to concurrent rebuild + scoring pushers and silently drop the snapshot.
type: feedback
originSessionId: b2919626-ae31-46d3-8e7b-d56285a9e090
archived: true
---
When a workflow's only contribution is a small audit/state file (no review-texts, no reviews.json) and it commits + pushes to public main as a standalone commit, **use `push-with-retry.sh 5 main`** — not 3.

**Why:** Solo state-file commits compete with rebuild + scoring pushers that come in bursts. Bigger commits ride alongside reviews.json and almost always win the rebase race because they're sequenced inside an established push pipeline. Lone audit pushes have no such advantage.

**How to apply:**
- Cron audit workflows that push only `data/audit/<state>.json`: 5 retries.
- Steps inside rebuild-fast.yml / rebuild-reviews.yml that just write the audit file: don't need their own push — `git add data/audit/*.json` + the rebuild's existing `push-with-retry.sh 5 main` handles it.
- Wrap with `|| echo "::warning::..."` only if losing the snapshot for one cycle is acceptable. Make the warning text name the data-loss consequence explicitly so daily-digest readers know whether to investigate.

**Caught 2026-04-26** in opening-night-completeness-check.yml first run (24965589737). All 3 attempts at 19:54/19:58/19:59 lost to concurrent rebuild + scoring pushers. Workflow showed green because of the swallow, but the state file never landed on origin/main, leaving the next cron tick with no prior snapshot to diff against — silent drop-detection failure. Fixed in commit `38fc2474ae` (3 → 5).

**Sibling at-risk:** `check-opening-night-drift.yml` line 158 still uses 3 retries with the same pattern. Drift detection is snapshot-vs-expected (not snapshot-vs-prior), so the failure mode is less severe — but worth bumping to 5 next time it's touched.
