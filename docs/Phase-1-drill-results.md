# Phase 1 (BRO-377) — dual-write window + induced-failure drill

**Run 2026-08-26 by the Linear-migration owner session, after the cutover crown
(workspace:19) died with Phase 1 never started.**

Status: **drill PASSED. Notion read-only NOT yet flipped** — that step is gated
on one owner decision, recorded at the bottom.

## 1. The 48h dual-write window — already satisfied, at scale

The card asks for 48 hours of dual-write. That did not need to be scheduled;
it has been running for a week. Both dispatchers are live and both append to
`data/audit/dispatch-ledger.jsonl`, with distinguishable task ids — numeric
for the Notion board, `linear:BRO-N` for the Linear one.

Counting `launch` + `job-spawned` events, 2026-08-20 → 2026-08-26:

| Board | Dispatches |
|---|---|
| Linear | 355 |
| Notion | 91 |

Command:

    grep '"ts":"2026-08-2[0-6]' data/audit/dispatch-ledger.jsonl \
      | grep -E '"event":"(launch|job-spawned)"' \
      | grep -o '"taskId":"[^"]*"' | sed 's/"taskId":"//;s/"//' \
      | awk '{ if ($0 ~ /^linear:/) l++; else if ($0 ~ /^[0-9]+$/) n++ } \
             END { print "Linear:", l+0; print "Notion:", n+0 }'

So the window is not a pending step. Seven days, 446 dispatches, both paths
carrying real production work.

## 2. The induced-failure drill

The card's real question is not "did both boards run" but **"if the Linear path
breaks, does the owner find out within one digest cycle, or is it swallowed?"**

Method — break the signal the owner actually reads, not a synthetic one. The
morning digest reads the Linear delegation health status file written by
`scripts/check-linear-delegations.js`; `send-morning-digest.js` resolves that
path from `CYRUS_HOME`, so pointing that at a directory holding a deliberately
9-hour-stale status file exercises the real reader, the real staleness rule and
the real render, with only the input synthesised. Nothing in production was
touched, and no email was sent (`--dry-run`).

**Induced failure:**

    CYRUS_HOME=<dir with a 9h-stale linear-delegation-status.json> \
      node scripts/send-morning-digest.js --dry-run

Rendered into the digest body, verbatim:

> Linear agents: the delegation check has not run for 9h, so nobody is watching
> whether delegated work is actually running.

**Control**, same command against the real status file: that sentence is
**absent** from the rendered digest (`grep -c` → 0).

Present when broken, absent when healthy. The drill is not vacuous, and the
failure surfaces in plain English rather than as a swallowed error.

**Verdict: PASS.** An induced Linear-path failure reaches the owner inside one
digest cycle.

## 3. What is NOT done, and why

Notion is **not** read-only yet, deliberately. Flipping it today would strand
real work: 91 dispatches in the measured window came off the Notion board, and
the Notion→Linear mirror (`data/linear-import-mapping.jsonl`) froze on
2026-08-20 at task id 1285. Anything filed on either board since has no
counterpart on the other, so `linearMirrorGuard`
(`scripts/lib/dispatch-guards.js:756`) returns null for all of it — the guard
against two sessions taking the same card is currently inert above that id.

Read-only before reconciling therefore does not migrate that work, it orphans it.

The reconciliation lever is `node scripts/linear-import.js --apply`. Dry-run on
2026-08-26: 189 mirror records, 47 already imported, 39 skipped, **103 import
candidates** (Infrastructure 56, Archive 20, Scoring quality 10, Coverage
pipeline 8, …). That is an owner-visible bulk write of ~103 issues onto his
board, which is why it is a decision and not a step.

## 4. Remaining sequence

1. **Owner decides** on `linear-import.js --apply` (below).
2. Run it; confirm the mapping's highest task id advances past 1285 and
   `linearMirrorGuard` stops returning null for current work.
3. Flip Notion read-only; disable the Notion poller
   (`scripts/notion-action-poll.js`).
4. Phase 3: BRO-382, BRO-384, BRO-385.

Already removed as a source of new divergence, 2026-08-26: CLAUDE.md rule 6 no
longer tells every session "Notion is the single source of truth — create a
Notion card." It now points at Linear and forbids the Notion fallback.

## Decision required before step 2

Running `--apply` puts roughly 103 issues on the Linear board in one write.
Not running it leaves two diverged boards and an inert double-dispatch guard.
The Archive-bucketed 20 are arguably not worth importing; they carry
`retiredReason`/`project: Archive`, which `liveLinearCounterpart()` already
treats as parked, so importing them is harmless but noisy.
