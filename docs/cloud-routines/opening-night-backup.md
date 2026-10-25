# Opening-night backup (cloud), one firing

Read by the "Opening-night backup (cloud)" routine each evening (~20:51 ET).
It replaces the Mac's `scripts/opening-night-backup-trigger.sh` (launchd
`com.bwsc.opening-night-backup-trigger`). GitHub cron fires 1 to 3 hours late,
so this routine dispatches the opening-night orchestrator at the intended time.
The orchestrator discovers tonight's openings itself and exits in under a
minute when there are none, so dispatching on a quiet night costs nothing.

No human is watching. Do nothing beyond the steps below.

## 1. Dispatch both markets

For each market in `broadway` and `west-end`, dispatch
`opening-night-orchestrator.yml` on `main` with input `market=<market>`:

- Preferred: `mcp__github__actions_run_trigger` (load with ToolSearch), method
  `run_workflow`, owner `thomaspryor`, repo `Broadwayscore`, workflow_id
  `opening-night-orchestrator.yml`, ref `main`, inputs `{"market": "<market>"}`.
- Fallback: `curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/repos/thomaspryor/Broadwayscore/actions/workflows/opening-night-orchestrator.yml/dispatches -d '{"ref":"main","inputs":{"market":"<market>"}}'`
  (HTTP 204 means dispatched).

Dispatch each market once. Do not retry in a loop; one retry after 30 seconds
on a network error is enough.

## 2. Report a failed dispatch

If either market failed both attempts, route a digest alert (the GitHub-native
crons are still scheduled, so this is degraded redundancy, not a page). From
/home/user/Broadwayscore on origin/main:

    node -e "require('./scripts/lib/owner-alert-router.js').routeAlert({conditionKey:'opening-night-backup-trigger-dispatch-failed',title:'Opening-night backup routine: orchestrator dispatch failed (<markets>)',description:'<error text>',severity:'warning',disposition:'digest'}).catch(()=>{})"

If the repo is missing, put the error in the reply instead.

## 3. Reply

One line per market: dispatched, or failed with the error. End with `SAFE TO ARCHIVE`.
