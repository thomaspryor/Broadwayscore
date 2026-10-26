# Cloud worker daily check, one firing

Read by the "Cloud worker daily check" routine each morning (~08:41 Berlin).
It checks that the board workers (the "Board workers: Claude + Codex" routine
and the Codex runner it starts, see docs/cloud-routines/board-workers.md) are
doing their job, and files one Linear card when they are not. It has no Mac
predecessor; it watches the cloud replacement for the Mac's dispatch loop.

No human is watching. Read-only apart from at most one Linear card. Never
message the owner except through that card, and never change a routine.

## 0. Setup

In /home/user/Broadwayscore: `git fetch origin main '+refs/heads/codex-runner-lock:refs/remotes/origin/codex-runner-lock'`
(retry with backoff; the lock ref may not exist, which is fine).

## 1. Is the routine firing?

Call `list_triggers` (claude-code-remote MCP; load with ToolSearch) and find the
routine whose name starts with "Board workers". Record `enabled`,
`last_fired_at` and `last_run.status`. Unhealthy if it is disabled without an
`ended_reason` a person set, if `last_fired_at` is more than 5 hours old, or if
`last_run.status` is FAILED.

## 2. Is work landing?

    git log origin/main --since='24 hours ago' --oneline | grep -cE 'BRO-[0-9]+'

and the Linear issues completed in the last 24 hours
(`issues(filter: { team: { key: { eq: "BRO" } }, completedAt: { gte: "<24h ago ISO>" } })`
via `scripts/lib/linear-client`). Zero landed card commits AND zero completed
issues in 24 hours while open Todo P0-P2 cards exist is unhealthy.

## 3. Is the Codex lock stuck?

If `origin/codex-runner-lock` exists, read its commit time
(`git log -1 --format=%cI origin/codex-runner-lock`). Older than 4 hours means a
runner died holding it: unhealthy.

## 3b. Is Codex landing anything?

A fresh lock does not mean Codex works: a runner that errors on every card
restarts each firing and keeps the lock young (2026-10-06..14: 25 runs, 2 cards
landed, and this check still read healthy). Ask the same reader and rule the daily
health row uses ("Codex runner: landing cards"):

    node -e "const L=require('./scripts/lib/linear-client.js'),R=require('./scripts/lib/codex-runner.js');L.listIssueComments(['BRO-4745']).then(m=>{const c=m.get('BRO-4745')||[];console.log(JSON.stringify(R.runnerHealth(c,Date.now())));for(const n of c.filter(x=>x.body.startsWith('## Codex runner 2')).slice(0,6))console.log(n.createdAt,'|',(n.body.match(/Landed and Done: (.*)/)||[])[1],'| crashed:',(n.body.match(/Runner error mid-card \(back to Todo\): (.*)/)||[])[1]);})"

Unhealthy if `status` is `error`. Quote its `message` in the finding as is: it
says which failure it is (no summary in 24h, a run stopped on its lock, or
nothing landed in 24h), and a lock stop while cards still land is not "lands
nothing". Name any crashed cards from the six newest runs printed below it. Never
query the comments with a raw GraphQL `last:` page: Linear's comment pages are
newest first, so `last: N` returns the OLDEST N, and past 50 comments on BRO-4745
that would freeze this check on old summaries (BRO-5287). If an open
card already covers it (search "Codex runner lands nothing"), comment there
instead of filing.

## 3c. Can the workers reach the urgent cards?

Work landing (step 2) does not mean the right work: from 2026-09-19 to
2026-10-14 the workers kept landing P3 cards while 46 P0/P1 cards sat in
Backlog where the picker could not reach them, and this check read healthy
(BRO-5360). Run the picker read-only and keep only its counts:

    node scripts/cloud-worker-pick.js 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({eligible:p.eligible,skipped:p.skipped,historySkipped:p.historySkipped}))})"

Unhealthy if `skipped["parked-or-backlog"]` is 15 or more: that many urgent
cards are parked where no worker can take them. Name the count and the top
skip reasons in the finding. Most such cards should come back on their own
(a paused card returns after its cooldown), so a high count means a new way
of parking cards that the picker does not know about.

## 3d. Do the provider keys still do their jobs?

Keys present is not keys working: in October 2026 every key authenticated while
ScrapingBee was blocked by the sandbox egress policy and Playwright could not
find its browser (BRO-6258). Run the functional smoke (one free read or one
credit per provider, no email):

    node scripts/check-cloud-secrets.js --smoke 2>&1 | tail -14

Report-only for now (CLAUDE.md §19): unhealthy if the exit code is 1; name the
failing groups from the `✗` lines in the finding and file it under step 4. Do
not retry in a loop; one re-run is enough if a line says `timeout`.

## 4. Record

If everything is healthy, make no changes. If anything is unhealthy, first
search for an open card about it
(`node scripts/linear-brain.js find "Board workers unhealthy"`); comment on it if
one exists, otherwise create one:

    node scripts/linear-brain.js create "Board workers unhealthy: <what>" --priority 2 --source routine:cloud-worker-check --park "routine health finding" --notes "<evidence: trigger fields, counts, lock age>\n\n## Acceptance criteria\nVERIFY: <safe-form command that shows it healthy>"

## 5. Reply

One line per check (healthy / unhealthy and why), the card URL if one was
filed, then `KEEP OPEN — the daily worker check fires into this session` (this
is a persistent host session: archiving it breaks the routine).
