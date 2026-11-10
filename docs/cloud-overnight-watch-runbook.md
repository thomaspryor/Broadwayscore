# Overnight watches from a cloud session

Moved out of `.claude/CLOUD.md` (BRO-7315) so it is read when a watch is planned, not by every session. The text is unchanged.

The owner lives in Berlin; US opening-night reviews drop 01:00-03:00 UTC. Anything needing their tap then fails (`list_sessions`/`create_session` prompt too, even in Auto mode), so a watch that re-arms itself with `send_later` dies after one pass.

0. **One session owns press night (BRO-6585).** The coordinator session (BRO-5955 lineage) owns every aggregator-listed review live and scored, and the lane trial, and starts fix workers. Any other session asked about that night reads the coordinator card first (`node scripts/coordinator-check.js --card BRO-N`), reports to the coordinator, and lands nothing for that show without its go. A hand-added review muddies the trial grade: only the coordinator adds one, recorded as manual.
1. **Reviews don't depend on a Claude watch.** `opening-night-orchestrator.yml` fires ~01:00-01:20 UTC nightly and dispatches the poller every 15 min for ~4.5 h; `aggregator-url-watcher.yml` runs every 5 min. Confirm they're armed (`node scripts/check-opening-night-readiness.js --show=ID`, recent orchestrator runs).
2. **If a Claude supervisor watch is wanted, schedule every pass while the owner is awake, in one go, and tell them before the prompts appear.** `create_trigger` with `initiation: "human_request"` and `persistent_session_id`. Minimum interval is 1 hour, so a 20-min cadence is three routines: `1 0-5 <day> <month> *`, `21 0-5 …`, `41 0-5 …`, `<day>` = the UTC date reviews land (the day after a New York opening). Avoid minute 0; check `next_run_at`. Add a `run_once_at` morning routine that deletes the three. Every pass prompt says: never call `send_later`/`create_trigger`, never relabel `initiation`. Point frequent passes at a lean `create_session` session.
3. Never plan a watch that re-arms itself, and never rely on ScheduleWakeup firing. `fire_trigger` doesn't rehearse this: it starts a new session without the repo.

