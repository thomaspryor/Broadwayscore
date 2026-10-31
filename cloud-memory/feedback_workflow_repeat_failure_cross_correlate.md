---
name: feedback_workflow_repeat_failure_cross_correlate
description: "Before fixing a \"workflow repeat-failure\" digest alert, cross-correlate with other workflows in the same time window — it may be a transient GitHub-wide push outage, not a code bug"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 21631620-beb4-4912-9ce8-b882764234c7
  modified: 2026-09-15T18:35:58.918Z
---

When a "Repeat Workflow Failures" digest card names one workflow, check whether OTHER unrelated workflows failed in the same time window before assuming the named workflow's code is broken (`gh api "repos/thomaspryor/Broadwayscore/actions/runs?created=<start>..<end>&per_page=100" -q '.workflow_runs[] | select(.conclusion=="failure")'`). If many unrelated workflows failed together with the same signature (`scripts/lib/push-with-retry.sh` logging `transport HANG` / `rc=124` on every retry attempt, including the Git Data API fallback), that's a real multi-hour GitHub git-push degradation window, not a bug in the named workflow.

**Why:** BRO-2525 (2026-09-15) named `update-show-score.yml` for 3 failures in 24h. All 3 were identical `push-with-retry.sh` transport-hang exhaustion. Cross-checking the same window (2026-09-13T15:13–2026-09-14T10:47 UTC) turned up 15+ other workflows failing with the identical signature (some workflows retried 10x at 30s each and still failed) — a repo-wide GitHub infra incident, not app code. It self-healed; 4/4 runs after the window succeeded.

**How to apply:** For any repeat-failure card whose failing step is `push-with-retry.sh` (or the `push-core-data` / `push-review-texts` composite actions that wrap it), run the cross-workflow query first. If confirmed as a shared outage window with recovery afterward, no code fix is needed — report the finding with the correlation evidence rather than editing `push-with-retry.sh` (shared infra — editing it needs `/second-opinion` first per CLAUDE.md rule 18 anyway, so ruling out "not a bug" first avoids an unnecessary review-gate detour). Only dig into workflow-specific logic if the failure signature is unique to the one named workflow, or if failures continue past the point other workflows recovered.
