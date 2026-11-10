# Opening-night lane switch and rollback (BRO-6622)

How a session turns the opening-night lane on or off for a market, stands it down, and rolls it back mid-night.
Cloud sessions get 403 on repo variables, so every change goes through `opening-night-lane-switch.yml`. Never ask
the owner to click in GitHub settings.

The two variables:

- `LANE_ONLY_MARKETS`: markets where the lane alone publishes on press night (`broadway`, `west-end`, a category such
  as `off-broadway`, or a comma list). Unset = the old path publishes everywhere.
- `LANE_STANDDOWN`: markets where the lane stops (`all`, or a market/category list). The lane sees it at its next
  heartbeat (every 10 min) and finishes its current pass.

The workflow refuses any other variable name, a typo in a market, `all` in `LANE_ONLY_MARKETS`, and an empty `set`
(use `clear`). `mode` has no default: `live` writes; `dry-run` and `drill` print the plan and end with
`NOTHING WAS CHANGED`. Every live run appends who, why, old value and new value to `data/audit/lane-switch.jsonl`.

Before turning the lane on for a market, read the latest BRO-5955 owner decision. The owner's hold on
`LANE_ONLY_MARKETS` stands until the owner lifts it there.

## How to dispatch

`mcp__github__actions_run_trigger` with `method: run_workflow`, `owner: thomaspryor`, `repo: Broadwayscore`,
`workflow_id: opening-night-lane-switch.yml`, `ref: main`, and `inputs` as below (all values are strings). Always set
`request_id` to a short unique tag, then find the run with `mcp__github__actions_list` (`list_workflow_runs`,
`resource_id: opening-night-lane-switch.yml`): the run name ends with the tag. Read the result with
`mcp__github__get_job_logs`; the step summary repeats the plan, the old and new values, and the restore lines.

1. Rehearse first: send the same inputs with `mode: dry-run`. Check the plan it prints.
2. Send it again with `mode: live`.
3. Wait for the run to finish green. A red run means a step failed; its log names the step. `mode: live` runs only
   from main.

## Turn the lane on for a market

`{"action":"set","variable":"LANE_ONLY_MARKETS","value":"broadway","reason":"<who asked, card>","mode":"live","request_id":"<tag>"}`

Only after the owner lifted the hold on BRO-5955. For two markets: `"value":"broadway,west-end"`.

## Turn the lane off (old path publishes again, the lane keeps running in shadow)

`{"action":"clear","variable":"LANE_ONLY_MARKETS","reason":"<why>","mode":"live","request_id":"<tag>"}`

## Stand the lane down

`{"action":"set","variable":"LANE_STANDDOWN","value":"all","reason":"<why>","mode":"live","request_id":"<tag>"}`
(or `"value":"west-end"` for one market). Undo with `action: clear`, `variable: LANE_STANDDOWN`.

## Roll back mid-night

Use this when the lane is publishing a night and must stop now, with the old path taking the night over.

`{"action":"rollback","show":"<show-id>","night":"<YYYY-MM-DD>","reason":"<why>","mode":"live","request_id":"<tag>"}`

Leave `show` and `night` empty to roll back every live lease and in-flight lane night run. `night` defaults to the
show's opening date. What it does, in order:

1. Sets `LANE_STANDDOWN=all` and deletes `LANE_ONLY_MARKETS` (skipped if already so).
2. Waits up to 15 min for the lane to stand down by itself. With `"hard":"true"` it skips the wait.
3. Cancels every lane night run still holding a target night, then waits once, up to 10 min, for all of them to
   finish their review-texts push. A night whose run is still going keeps its lease and gets no old-path run.
4. Releases that run's lease, only if the same run still holds it (a fresh claim is never cut). A night whose lease
   changed hands is left alone and gets no old-path run either.
5. Inside the press-night window (embargo -3h to +6h) it starts the old path once
   (`opening-night-orchestrator.yml` with the show and its market). It uses the watchdog's claim, so a rollback and
   the watchdog never both start it.

A cancelled lane run pages Discord with a warning; that is expected after a rollback. If `ORCHESTRATOR_PAUSED` is set,
the summary warns that the old path will not publish until it is cleared. If a variable write fails (403), the run
still releases the lease and starts the old path, then goes red. Any red rollback: send the same rollback again. It
skips what is already done, and never starts the old path twice. If it says an earlier rollback claimed the night,
wait 10 min first.

### Afterwards

The summary lists the restore lines (for example `clear LANE_STANDDOWN`, `set LANE_ONLY_MARKETS=broadway`). Once the
problem is fixed and the owner agrees, send each one as its own `set`/`clear` dispatch.

## Drill

`{"action":"rollback","reason":"drill","mode":"drill","request_id":"<tag>"}` seeds a synthetic lease for
`drill-synthetic` on the `opening-night-lane-drill` branch, writes and deletes the scratch variable
`LANE_SWITCH_PROBE` (proves the token can write variables), runs the real release and claim against the drill
branches, and checks a second pass starts nothing. It never touches the real lease branches, the two lane variables,
any run, or the orchestrator.

## Pre-embargo direct-only window (BRO-7280, default OFF)

`LANE_PREEMBARGO_DIRECT_ONLY` (value `on`; `clear` = off) makes every lane fetch plain HTTP (`directOnly: true`, no
Browserbase, no paid fallback) until embargo minus 30 min, and refuses paid SERP until then. Normal fetching resumes at
embargo minus 30 min. Unset = byte-identical to before. Turning it on is an owner money call: never set it without the
owner's word on the card.

- Start: `min(embargo - 30 min, max(19:30 local in the market tz, embargo - 90 min))`. For a 22:00 ET embargo that is
  20:30 ET, so the window is about 60 min. The lane window is 275 min when on (270 off), so the lane ends about 55 min sooner after the
  embargo (about E+185 min instead of E+240). The 355-min job cap and audit-push-retry-budgets allow no more.
- The SERP "+3h" clock stays anchored at embargo minus 30 min, so an early start never moves SERP spend earlier.
- Failures caused by the window are tagged `laneDeferred`: they do not count as retry attempts, Google News strikes or
  Talkin' Broadway blocks.
- `night-wait` reads the variable once per night; the lane job reuses that value. The switch refuses to change it while
  a night run is in flight.
- Changing lane code changes `laneCodeHash`. Landing on main runs `lane-rehearsal-recorded.yml` (path filter), which
  re-arms the lane under the new hash. Check with `node scripts/opening-night-lane-rehearse.js --arm-check`.
- Proof after a night: `node scripts/lane-preembargo-spend-check.js --from=<window start> --to=<embargo - 30 min>
  --show=<id>` must print `OK: zero paid lane calls`. Unit proof: `node --test tests/unit/lane-preembargo-window.test.mjs`.

Code: `scripts/lane-switch.js`, `scripts/lib/opening-night-lane/lane-switch.js`. Tests:
`node --test tests/unit/lane-rollback.test.mjs`.
