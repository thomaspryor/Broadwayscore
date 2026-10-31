---
name: feedback_log_failed_names_wrong_step
description: "gh run view --log-failed includes ##[error] output from continue-on-error steps, so its tail names the wrong failing step — query the jobs API for the real one"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 09e802b2-5615-46b3-876f-e310796649ce
  modified: 2026-08-15T12:43:58.501Z
---

`gh run view <id> --log-failed` streams the log of a FAILED JOB, not of the failed
step. Any step in that job that emitted `##[error]` appears too — including steps
marked `continue-on-error: true`, which by definition did NOT fail the job. Reading
the tail of that output therefore names the wrong cause.

Get the real failing step from the jobs API instead:

```
gh api repos/thomaspryor/Broadwayscore/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[] | select(.conclusion=="failure") | "JOB: \(.name)",
        (.steps[] | select(.conclusion=="failure") | "   FAILED step: \(.name)")'
```

Then grep the cached log for THAT step's output. Cache the log once
(`gh run view <id> --log-failed > /tmp/run.log`) and grep it locally — repeated
fetches trip `~/.claude/hooks/gh-poll-block.sh` (add `# FORCE-POLL` for a genuine
one-off inspection of a specific run).

**Live case (2026-08-15, run 31880306250):** the tail of `--log-failed` ended in
`push-with-retry: All push attempts failed after 7 attempts` + `Process completed
with exit code 1`, which reads exactly like the cause. It was not. That output came
from the `Commit scraper-spend ledger` step, which carries `continue-on-error: true`
and cannot fail the job. The actual failing step was `Audit sibling-title misroute
(strict)` — a data audit reporting 5 misrouted reviews — 15 minutes earlier in the
log. Diagnosing from the tail would have sent the session to rewrite a push
primitive (shared infra, `/second-opinion`-gated) instead of deleting five bad data
files.

Same family as [[feedback_pipe_masks_exit_code]] (`cmd | tail` reports tail's status,
not cmd's — `EXIT=$?` after a pipe is always a lie) and
[[feedback_silent_workflow_failures]]. The generalisation: **an error message is
evidence that SOMETHING printed it, never evidence of what failed.** Ask the
structured source which step has `conclusion: failure` before believing prose.

**Why this matters here:** nearly every main-red this week was a reporting failure
rather than broken code, so the framing a failure hands you is the least trustworthy
part of it.
