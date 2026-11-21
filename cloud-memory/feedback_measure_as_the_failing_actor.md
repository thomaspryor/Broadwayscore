---
name: a-latency-measurement-taken-as-the-wrong-actor-does-not-discriminate
description: "Before concluding a cause from a timing/behaviour probe, check you ran it as the SAME identity, environment and credential as the failing case. A probe that isolates the resource but not the actor cannot separate resource-contention from actor-throttling, and both hypotheses demand opposite fixes."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 04071233-18bf-46a2-8362-494dbfa44e6d
  modified: 2026-09-08T16:02:28.906Z
---

BRO-2951: `push-via-git-api.sh`'s fallback burned its full 90s cap on 6/6
attempts with ZERO lost ref races. I measured, from my Mac under the owner's
credentials, that a 128 KB payload reached a scratch ref in ~1.8s three times
running while the same payload to `refs/heads/main` timed out at 90s. I
concluded ref-lock contention on the busy branch and proposed a fix built on
that.

Plan-review killed it. **The failing pushes are `github-actions[bot]`, not the
owner.** `push-via-git-api.sh`'s own header already hypothesized "throttling of
receive-pack traffic under sustained concurrent push volume FROM THE SAME
ACTOR". My probe changed the *ref* while holding the actor fixed at the WRONG
value, so it could not distinguish:

- H1 ref-lock contention on `main` → fix: stop using receive-pack for the ref update
- H2 actor-level throttling of that bot's writes → fix: reduce write volume / move the state off `main`

Both produce an identical "fast to ref A, 90s to ref B" signature when measured
from an unthrottled identity. The proposed fix would have been a silent no-op
under H2 — and, separately, would never have activated at all, because the
failing workflow step declares no token in its `env:` block.

## Rule
Before drawing a causal conclusion from any timing or behaviour probe, ask
what varies between the probe and the failing case — not just the variable you
deliberately changed. Specifically check identity: **actor/user, credential,
IP/runner, and concurrency neighbourhood.** If any differs, the probe is
suggestive, not discriminating.

When they can't be matched locally, ship the measurement INTO the failing
context (right actor, right moment, right failure class) and let it decide,
rather than shipping a cure built on the unproven mechanism. Put that
measurement somewhere a human will actually see it — a `::notice::` annotation
or `$GITHUB_STEP_SUMMARY`, not a bare stderr line nothing greps.

Related: [[feedback_investigate_premise_before_scaling.md]],
[[feedback_verify_bug_claim_before_fixing.md]]
