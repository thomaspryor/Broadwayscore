---
name: feedback_linear_dispatch_overlap_warnings
description: "linear-next.js prints file-overlap warnings against in-progress cards before dispatching — read them before proceeding, not after"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a15d9f9e-d9c3-4f77-b4bd-eebe09b999d2
  modified: 2026-09-11T18:50:54.608Z
---

`node scripts/linear-next.js --id BRO-N` prints one `[linear-next] WARNING: ... shares file(s) X with in_progress work BRO-M (...)` line per overlapping in-progress card, then dispatches anyway regardless — it warns, it does not block. Skimming past these and dispatching on autopilot filed and launched a duplicate workspace (BRO-3177, 2026-09-11): the warnings named BRO-2446 (In Review) and BRO-3071 (Todo) as already covering the exact same "unregistered data/audit/ push-race path" detector, but the dispatch went ahead first and the actual overlap check only happened after the workspace was already running, requiring a Duplicate-state cleanup + a SendMessage to the just-launched session telling it to stop.

**Why:** the tool's warn-not-block design assumes the caller reads the warnings as a real gate, not decoration — it can't know from a file path alone whether two cards are truly the same work or just adjacent. `node scripts/linear-brain.js find "<key phrase from the warned card's title>"` before dispatching, not after, would have caught this in one call.

**How to apply:** whenever `linear-next.js`/`bsc-next.js` prints a file-overlap warning during a `/what-else`-style auto-dispatch (Phase 5.5), stop and look up the named card(s) (`linear-brain.js find` or `linear-client.js getIssue`) BEFORE letting the dispatch proceed — not as a follow-up if something feels off. If it turns out to be a real duplicate, mark the new card Duplicate-of the existing one and message the dispatched session to stand down immediately, rather than letting it start implementing.
