---
name: go-live-now
version: "1.0.0"
description: "Use the moment the owner says ASAP, live now, right now, jump the queue, as fast as possible, or 'no job is more important than this' about getting a change onto broadwayscorecard.com (opening nights above all). Do every step below unasked, in this order, in the same turn: land it, free GitHub runners, clear the landing line, start the deploy yourself, cancel stale deploys, watch it to READY. Written after Wanted (2026-11-09), where the owner had to ask four times and a one-line data fix sat about 20 minutes behind routine jobs."
allowed-tools: Bash, Read
user-invocable: true
---

# /go-live-now: get one change onto production as fast as the system allows

The owner's "ASAP" is the authorization for every step here. Do not ask
"want me to cancel X?", do not report "it's waiting its turn", do not wait
for the owner to suggest the next idea. Reporting "it's queued" before steps
2 to 4 are done is the failure this skill exists to stop.

Where the time went (Wanted, 2026-11-09): checks about 4 min, then the Land
job sat 10 min queued for a runner (34 runs in progress; the account's
concurrent-job cap was full of long press-night watchers, shadow lanes,
tests and demo deploys), landing 1 min, then the deploy job queued again for
a runner before a 10 to 15 min build. Runner waits and the line in front of
you are the only compressible parts. Attack them before the checks finish.

## 1. Land it (never push main)
`git push origin HEAD:refs/heads/land/<name>`. Keep the diff minimal: a
data-only diff skips the gauntlet and its checks finish in about a minute.

## 2. Free runners now, in parallel with the checks
List runs with GitHub MCP `actions_list` / `list_workflow_runs`, once with
`workflow_runs_filter: {"status":"in_progress"}` and once with `"queued"`
(the output is large: save it and parse id, name, head_sha, created_at).
Cancel with `actions_run_trigger` / `cancel_workflow_run`, all in one message.
Recheck the queued list every couple of minutes until your deploy is
building: automation re-queues things (for example "Land retry on cancel").

Safe to cancel (each reruns on its own schedule or can be rerun later):
- `Test Suite` and `Check Direct Push To Main` on main pushes
- `Deploy Demo Site`, `Demo Alias Watchdog`, `Mirror Core Data to GitLab`
- `Fetch Show Images`, `Update Critics' Take`
- opening-night lane shadow runs, press-night probes and watchdogs for
  OTHER shows (anything marked dry run or shadow)
- `Gather Review Data` and `LLM Ensemble Score` for other shows that are not
  opening tonight
- `Land retry on cancel`, and other sessions' `land/**` runs that are still
  queued or in the Checks phase (note their run ids and rerun them with
  `rerun_workflow_run` after yours has landed)

Never cancel:
- any run for the show you are rushing (orchestrator, poller, lane, rebuild)
- a `Land` job past "Wait for the landing mutex" (a landing in flight)
- a `Deploy to Vercel` run whose head sha contains your commit
- `opening-night-lane-switch`, `execute-approved-fix`, rebuild-reviews
- `Morning Digest` and email workflows (they reach real people)

## 3. Clear the line in front of you
The landing mutex is a FIFO of refs: `git ls-remote origin 'refs/land-mutex/*'`.
Landings waiting there also ride your merge train and get re-checked with
you. Cancelling other queued land runs (step 2) lets your Land job take the
lock alone. Then wait for main:
`until git fetch -q origin main && git merge-base --is-ancestor <sha> origin/main; do sleep 15; done`
(Bash run_in_background, timeout longer than the wait).

## 4. Deploy yourself and stop stale deploys from overwriting you
The Land job requests a deploy, but start one too the moment your commit is
on main: `actions_run_trigger` / `run_workflow`, `workflow_id: vercel-deploy.yml`,
`ref: main`. Deploy runs run side by side (per-run concurrency group), so an
older deploy that finishes last can put pre-fix content back. For each
queued `Deploy to Vercel` run, check
`git merge-base --is-ancestor <your sha> <its head_sha>`; cancel the ones
that do not contain your commit. Then confirm a deploy containing your
commit has a runner (its `deploy` job is in_progress). If it is queued,
go back to step 2.

## 5. Watch to READY, then check the page
`node scripts/check-prod-deploy.js <sha> --wait`, then load the live page and
confirm the change shows. Only then tell the owner it is live.

## 6. Clean up
Rerun the other sessions' land runs you cancelled (`rerun_workflow_run`).
Routine jobs (tests, mirror, demo, images, scoring) rerun on their schedule.

## Telling the owner
Say what you did, with times ("cancelled 12 background jobs, the fix got a
machine at 03:45"). Give the honest remaining time: the deploy build itself,
10 to 15 minutes, is the floor.
