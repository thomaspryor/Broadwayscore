---
name: feedback-liveness-needs-lsof-not-mtime
description: "A dispatched job's liveness must be settled by lsof on its log plus the absence of a terminal ledger row — log mtime, pgrep, and exit codes through a pipe all lie"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8899cd69-1b2f-4580-9fa0-80a93fdd9517
  modified: 2026-09-08T14:27:23.989Z
---

Before believing a dispatched job is still running, check **lsof on its log file**
AND **the absence of a terminal ledger row**. Log growth alone is not liveness.

**Why:** on 2026-09-08 five separate single signals each reported the wrong answer
within one session:

* a dead job's log **mtime** was 1.4 minutes old — that was its dying write
  (`linear:BRO-2961-mts3xq2h`, confirmed dead by `lsof` returning no writer)
* **`pgrep`** on both the issue id and the job id found nothing, which is not
  evidence of death: the process argv carries a temp seed path, not either id
* `scripts/lib/wait-for-run.sh <id> | tail -N; echo $?` reported **exit 0 while
  CI had failed** — `$?` captured `tail`, not the script. The script returns 1
  correctly; the invocation was wrong. Never pipe it and then read `$?`.
* a watcher started with `cmd &` *inside* an already-backgrounded call exited 0
  after one poll, killed when its parent returned
* `gh run view <id> --log-failed | grep <test name>` "found" a failing test 8
  times when it had **passed** — `--log-failed` prints the whole job log for a
  failed job, so the hits were passing subtest names

**How to apply:** for a job, `lsof "<logFile from the job-spawned ledger row>"`
— no writer means dead — and confirm no terminal event
(`job-done|job-failed|job-orphaned|job-abandoned|watchdog-*|prune-closed|dead|vanished`)
in `data/audit/dispatch-ledger.jsonl`. For CI, call `wait-for-run.sh` directly
and read its own exit code, or re-query `gh run view --json conclusion`. When a
grep over a log "confirms" something, check whether the log contains both the
passing and failing lines before trusting the count.

Related: [[feedback_github_polling_rate_limit]], [[feedback_verification_gate_hook]],
[[feedback_pipe_masks_exit_code]].
