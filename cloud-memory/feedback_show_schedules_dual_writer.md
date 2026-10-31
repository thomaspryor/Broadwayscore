---
name: show-schedules.json has two writers with different semantics
description: scrape-lottery-rush.js overwrites entirely (Broadway only); fetch-todaytix-showtimes.js reads then merges additions (WE/OB only). Merge conflict resolution must preserve both halves.
type: feedback
originSessionId: ad4a33ca-5751-4533-a117-5ec42911d332
archived: true
---
`data/show-schedules.json` is written by TWO scripts with opposite semantics:

1. **scripts/scrape-lottery-rush.js** — `fs.writeFileSync(SCHEDULE_PATH, ...)` with `scheduleShows` that only contains the 38 Broadway shows it scrapes from bwayrush. Every run **wipes WE/OB entries**.
2. **scripts/fetch-todaytix-showtimes.js** — `JSON.parse(readFileSync(SCHEDULES_PATH))`, then `schedules.shows[id] = {weeks}` for WE/OB shows only (skips shows already present), then `writeFileSync`. **Additive merge** that respects bwayrush entries.

In CI the sequence is: lottery-rush runs on cron → todaytix runs on its own cron → file ends up with both sets. Between runs, WE/OB data can briefly disappear.

**Why:** On 2026-04-24 during the showtimes-card fix, git merge of my Broadway-only scraped file against origin/main's combined file produced a conflict. `git checkout --theirs data/show-schedules.json` (= my Broadway-only write) clobbered 110 WE/OB entries. Recovery: use origin/main as base, overlay my multi-week Broadway data on top.

**How to apply:**
- Never use `--theirs` or `--ours` blindly on show-schedules.json merge conflicts. Manually merge: origin/main has the combined superset; overlay the fresh Broadway entries from the scraper output.
- Before writing, verify both markets are present: `node -e "const s=require('./data/show-schedules.json'); const bw=Object.keys(s.shows).filter(id=>!id.includes('west-end')&&!id.includes('off-broadway')).length; const we=Object.keys(s.shows).length-bw; console.log('bway:',bw,'we-ish:',we)"`
- If you change the lottery-rush scraper's output path, also update fetch-todaytix-showtimes.js so its read-then-write still works.
