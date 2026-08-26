# BRO-373 — the Codex delegation lane is DROPPED

**Status: DROPPED (decided 2026-08-26 by the Linear-migration owner session).**
**Scope: Codex as a _Linear delegation agent_ only. Codex as an adversarial reviewer stays.**

## The two things called "Codex" — only one is dropped

| Lane | What it is | Verdict |
|---|---|---|
| Codex **delegation** lane | `@codex` mentioned on a Linear issue, expected to open an agent session and drive the work to a PR the way Cyrus does | **DROPPED** |
| Codex **review** lane | Codex invoked as a second opinion / adversarial reviewer on work Claude already wrote | **KEPT — it works and pays for itself** |

The review lane is not theoretical: `scripts/bsc-next.js` carries three separate
fixes that exist only because a Codex adversarial review found them (the
`release`-keyed-on-taskId lock race, the slow-boot-vs-dead succession
distinction, and the cross-dispatcher duplicate-tab guard). Dropping *that*
would delete a working source of real bug reports. This decision does not touch it.

## Why the delegation lane is dropped

Phase 0's gate was that BOTH runners reach a merged PR. Cyrus passed
(BRO-7 → PR #571, BRO-8 → PR #572, both merged). Codex never started once:

* **BRO-263** was created specifically as the Codex-lane smoke test and delegated
  to the codex agent. It sat **8,434 minutes (5.8 days)** producing only
  boilerplate activity and zero substantive output.
* `node scripts/check-linear-delegations.js` classified BRO-263
  `stalled — agent accepted the work and is doing nothing`, which is the worst of
  the failure modes: the board showed the work as assigned and in hand the entire time.
* The only substantive replies the codex agent has ever posted on this team are
  the two authorization stubs on BRO-373 itself:
  *"To use Codex, link your ChatGPT account"* and a connector authorization link.
* As of this decision, `node scripts/check-linear-delegations.js` exits 0 with
  **no codex delegation of any kind in flight** — the lane is already empty in practice.

The blocker is not a bug we can fix from this machine: it needs a ChatGPT/Codex
cloud environment linked to `thomaspryor/Broadwayscore` by the account owner, in a
web UI. Keeping a lane open that (a) requires a manual owner step nobody has taken
in the two weeks since BRO-263, and (b) fails *silently as assigned work* when
unstarted, is strictly worse than not having it: a stalled delegation looks
identical to a working one on the board.

## The re-cost this replaces (Claude/Codex split vs Max limits)

The original plan assumed delegation load would split across two runners, so
neither would approach its own limit. With Codex dropped, **100% of Linear
delegations route to the Cyrus/Claude lane.** That is affordable at the current
and projected volume, and the load is not the binding constraint:

* Observed delegation volume is single-digit concurrent
  (`check-linear-delegations.js` at the time of this decision: one delegation,
  `finished`). This is nowhere near a rate ceiling.
* The dispatch layer already has its own caps that bind long before an account
  limit does — `dispatch-ledger.js`'s `dispatchCapDecision`,
  `SUCCESSION_DEPTH_CAP`, `DEAD_ATTEMPT_LIMIT`/`INFRA_DEAD_ATTEMPT_LIMIT`, and
  the runner budget caps from BRO-380 Phase 2 (PR #592). Those are the real
  throttle; a second runner would not raise them.
* The failure mode a second lane was meant to hedge (one runner down = all work
  stops) is already covered differently: work that a delegation cannot take is
  dispatched to a local cmux workspace through `bsc-next.js`, which does not
  depend on either hosted runner.

## How to reverse this

Reversing is a deliberate act, not a drift. Do all three:

1. Link the ChatGPT/Codex cloud environment to `thomaspryor/Broadwayscore` (owner, web UI).
2. Re-run one low-stakes delegation to `@codex` **with a kickoff comment in the
   session thread** — delegation alone does not start Linear agents — and confirm
   it reaches a merged PR.
3. Update this file and `tests/unit/codex-delegation.test.mjs`, which asserts this
   decision is recorded and that no repo code routes a Linear delegation to codex.
   That test fails on purpose if the lane is re-added without revisiting this page.
