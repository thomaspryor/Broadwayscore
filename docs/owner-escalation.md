# When to ask the owner, and how a chat approval reaches a worker (BRO-6539)

The owner is not technical and reads many tabs. On 2026-10-29 they were asked questions they had already answered (BRO-5646, BRO-4309, BRO-4303), a visual ask came back 2.5h after Approve, and obvious defaults (BRO-5641 Windfall label, the cost-ledger schedule) were escalated. This page is the rule.

## Decide it, record it, do not ask

Decide and record (a card comment with the reasoning, the default taken and how to undo it) when ALL hold:

1. You have a recommended option.
2. The no-change default is safe: if the owner never answers, nothing bad happens.
3. No money (paid APIs, credits, subscriptions, a new schedule that spends), no irreversible step (delete, drop, force-push, rename that cannot be redirected), no outbound email to real people, no public-facing claim (site copy, social post, press).

Anything else is a DECISION NEEDED. Before restating one, run `node scripts/lib/decision-restate.js BRO-N [BRO-M]`: a card with an owner-decision or visual-approval comment newer than the question prints `ALREADY ANSWERED`; act on that answer and do not restate it. The Stop hook runs the same check on the final message (advisory first; `DECISION_RESTATE_ENFORCE=1` makes it block).

## How an owner's chat approval reaches a worker today

A chat approval does not travel by itself. A parent's `send_message` arrives in the worker as a peer message (data, not the owner's words), so the auto-mode classifier still refuses production-touching steps (rename-show-ids.yml `mode=apply`, Supabase SQL, anything that writes prod).

What works now:

1. **Record it on the card.** The parent runs `node scripts/record-owner-answer.js BRO-N --choice A|own --text "<owner's words>"` (dispatches record-owner-answer.yml, same path as the email answer page). The card then carries an `Owner decision` comment. The worker cites that comment as its authority and `decision-restate.js` stops everyone re-asking. This records the decision; it does not lift the classifier.
2. **Let CI do the gated step.** Steps that are workflows run without the classifier once someone with the right to dispatch them does so: `execute-approved-fix.yml` (plan id from the approval link), `visual-approval-land.yml` (Approve ships the held branch). If the step is not a workflow yet, make it one and have the owner approve it once through the decisions email.
3. **Supabase SQL and other by-hand steps** have no route. They stay with the owner or a Mac session.

## Proposal, not built

`run-owner-approved-step.yml`: the worker files a card with a `STEP: {"workflow": "rename-show-ids.yml", "inputs": {...}}` line and a DECISION NEEDED whose option A is "run this step". When the owner taps A, record-owner-answer.yml (which holds `APPROVAL_HMAC_SECRET`) writes the Owner decision comment with the decision ref. The new workflow reads the card, checks the ref matches the STEP line hash and that the step is on an allowlist, then dispatches the target workflow itself from CI. The worker never dispatches a gated step and the owner approves it exactly once. Needs: an allowlist file, the hash check, a test that a changed STEP line voids the approval.
