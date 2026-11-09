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
building: automation re-queues things (cancelled tests start follow-up jobs).

The lists below mirror `scripts/lib/press-night-priority.js` (BRO-7198), which
holds the reasons; `scripts/lib/go-live-now-skill.test.mjs` fails if they drift.
During a Broadway press night (embargo -1h to +6h) you can get the plan from it:
save the run list to a file, then
`node scripts/press-night-priority.js --runs-file=<file>` (dry run, cancels nothing).

Safe to cancel (each reruns on its own schedule; side effects named):
- `demo-alias-watchdog.yml`
- `vercel-demo.yml` while still queued (a running demo build left half done
  leaves the demo alias on stale content)
- `llm-ensemble-score.yml` and `press-night-watchdog.yml` for shows not
  opening tonight, while still queued (the 6-hourly batch scores whatever is
  left). A running one still pushes when cancelled and keeps its runner up to
  ~10 more minutes, so leave it unless nothing else frees a machine
- `test.yml` and `check-direct-push-to-main.yml` on main pushes (each cancel
  re-queues a follow-up job, so recheck the queue)
- `mirror-data-to-gitlab.yml`, `fetch-all-image-formats.yml` (each raises a
  cancelled alert; expected; prefer queued ones)
- `gather-reviews.yml`, `press-night-probe.yml`,
  `opening-night-lane-watchdog.yml`, and `opening-night-lane-live.yml` shadow
  runs, only for shows not opening tonight
- other sessions' `land.yml` runs that are still queued or in the Checks
  phase (note their run ids and rerun them with `rerun_workflow_run` after
  yours has landed)

Never cancel:
- any run for the show you are rushing, or for any show opening tonight
  (orchestrator, poller, lane, rebuild, scoring)
- `update-critic-consensus.yml` (Critics' Take): its title never names the
  show, and its push and deploy steps run even when cancelled, so a cancel
  publishes a partial file
- `land-retry-cancelled.yml`: it re-runs cancelled Land jobs, one of which
  may carry tonight's fix
- a `land.yml` job past "Wait for the landing mutex" (a landing in flight)
- a `vercel-deploy.yml` run whose head sha contains your commit
- `opening-night-lane-switch.yml`, `execute-approved-fix.yml`,
  `rebuild-reviews.yml`, `rebuild-fast.yml`, `extract-pull-quotes.yml`,
  `opening-night-poller.yml`, `opening-night-orchestrator.yml`
- `morning-digest-action.yml`, `opening-night-broadcast.yml` and other email
  workflows (they reach real people)
- `autonomous-merge.yml` (holds the same landing mutex as Land) and
  `update-deploy-watermark.yml`

## 3. Clear the line in front of you
The landing mutex is a FIFO of refs: `git ls-remote origin 'refs/land-mutex/*'`.
Landings waiting there also ride your merge train and get re-checked with
you. Cancelling other queued land runs (step 2) lets your Land job take the
lock alone. Land self-parks when the line is 4+ deep: if your Land job ends
cancelled at "Admit to the landing queue", rerun it yourself at once
(`rerun_workflow_run`); do not wait for the retry cron. Then wait for main:
`until git fetch -q origin main && git merge-base --is-ancestor <sha> origin/main; do sleep 15; done`
(Bash run_in_background, timeout longer than the wait).

## 4. Deploy yourself and stop stale deploys from overwriting you
The Land job requests a deploy, but start one too the moment your commit is
on main: `actions_run_trigger` / `run_workflow`, `workflow_id: vercel-deploy.yml`,
`ref: main`. Your ASAP is the emergency that dispatching this workflow by
hand is reserved for. Deploy runs run side by side (per-run concurrency group), so an
older deploy that finishes last can put pre-fix content back. For each
queued `Deploy to Vercel` run, check
`git merge-base --is-ancestor <your sha> <its head_sha>`; cancel the ones
that do not contain your commit. For a private core-data fix (landed through
execute-approved-fix, so no sha of yours is on main), the deploy must have
started after the data commit landed; judge by its start time, not its sha.
Then confirm a deploy containing your
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
