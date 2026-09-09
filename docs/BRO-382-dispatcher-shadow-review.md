# BRO-382 — dispatcher + watchdogs: shadow review, then off

**Reviewed and switched off 2026-08-31.** This is the review the card requires
before anything is switched off.

## The card's premise was wrong, and this is what replaced it

BRO-382 asked for "a logged diff between what the dispatcher WOULD have done and
what Linear actually did". That diff cannot be built and would measure nothing:

* The id namespaces have no join key for a per-task diff.
* A "both dispatchers took this task" bucket is empty **by construction** —
  `linearMirrorGuard` (`scripts/lib/dispatch-guards.js:756`) refuses Notion-side
  dispatch of any task with a live Linear counterpart.
* A ledger-only diff is blind to every refusal that exits before a ledger write.

The honest equivalent — and what actually answers "is it safe to switch off?" —
is the guard tally that already exists: for every queued Notion card, what each
of the 8 dispatch guards WOULD refuse. That is
`scripts/lib/dispatch-guard-queue-audit.js`, whose snapshot the daily
`predispatch-queue-audit` job writes.

## The shadow period

The tally ran unattended and is recorded in
`data/audit/dispatch-guard-queue-audit-history.json`:

| | |
|---|---|
| Observations | 8 |
| Window | 2026-08-19 → 2026-08-31 (12 days) |
| Blocked count | 76 → 117 (rising as Linear took over) |

Note the audit was itself dead from 2026-08-20 to 2026-08-26 (BRO-2314 — its
sync gate could not fast-forward past dirty ledgers). The window spans that
outage; the observations either side are real.

## What the final snapshot says (2026-08-31)

185 queued Notion cards:

| Guard | Would refuse |
|---|---|
| **linearMirrorGuard** | **92** |
| staleOutcomeGuard | 22 |
| deadDispatchGuard | 10 |
| parkedGuard | 7 |
| closedCardGuard | 4 |
| workBranchCollisionGuard | 2 |
| exactTitleOverlapGuard | 0 |
| sessionTrackingCloneGuard | 0 |
| **Blocked by at least one** | **117 of 185** |

The headline number is the first row. **Half the remaining Notion queue is work
Linear already owns** — the Notion dispatcher would have been refused on 92 of
185 cards because a live Linear counterpart exists. That is the migration
showing up as data rather than as an assertion.

The predispatch classification on the same run: 75 blocked from auto-dispatch
(28 reopen-suspect, 47 do-not-dispatch), 76 ok-to-dispatch, 34 check-first.

## The decision

**Switched off, not shadowed further.** Log-only was the card's cautious middle
step, and it is not worth taking: the guards already refuse the majority of the
queue, the Notion board has been read-only for new pages since 2026-08-26
(BRO-377), and the Linear lane is demonstrably carrying the work — **74 Linear
dispatches in the 24h before this decision**.

Switched off, both via launchd rather than code, so it is reversible in one
command and needed no change to the critical-tier dispatch layer:

| Job | Runs | Action |
|---|---|---|
| `com.bwsc.action-dispatcher` | `scripts/notion-action-poll.js` | booted out, plist `.disabled-2026-08-30`; script also guarded (BRO-384) |
| `com.broadwayscore.backlog-drain` | `scripts/backlog-drain.js` | booted out, plist `.disabled-2026-08-31` |

`backlog-drain` was the last live Notion-side dispatcher: it loads the Notion
task mirror (`~/.claude/tasks/`), resolves cards with `notionIdOf`, and
dispatches them through `bsc-next`. It is Notion-only; Linear has its own
`scripts/linear-drain-parked.js`.

## What deliberately stays running

Three loaded jobs still reference Notion. All were checked; none dispatch:

* `com.broadwayscore.predispatch-queue-audit` — writes the very tally above.
  Retiring it would delete the evidence trail.
* `com.broadwayscore.reconcile-dead-completions` — reopens tasks marked done
  whose dispatch never ran. It corrects status via `pages.update`, which
  read-only deliberately still permits.
* `com.broadwayscore.hook-liveness` — observer only.

## The one thing this does NOT resolve

76 Notion cards classified ok-to-dispatch will no longer be auto-dispatched.
They are not lost — they sit in the mirror and in Notion — but nothing will pick
them up. The importer skips most of this residue by rule (noise, completed,
blank-title), which is why they never reached Linear.

Draining or explicitly abandoning those 76 is the remaining tail and belongs to
BRO-385 (freeze ledgers, close ~90 self-referential cards), which is already In
Review. It is called out here so the number is not discovered by surprise.

## Verification

    node -e "…dispatch-guard-queue-audit-snapshot.json…"   # the tally above
    launchctl list | grep -cE 'action-dispatcher|backlog-drain'   # → 0
