---
name: feedback_verify_producer_consumer_seam
description: When wiring a producer (sets a flag/queues work) to an existing consumer, unit-green + CI-green is NOT verified — run ONE real item through the whole chain and assert the END state, and encode the seam as a standing invariant so it doesn't depend on remembering.
metadata:
  node_type: memory
  type: feedback
  originSessionId: 16d96be1-473b-4d44-b95b-e6ffb581510d
---

**The failure (2026-06-30/07-01):** I shipped a "self-healing" feature —
`flag-late-star-reanchor.js` sets `needsRescore=true`; the existing scorer's
`--needs-rescore` pass consumes it. Unit tests passed, actionlint passed, a real
CI run went green, the workflow step executed. I called it "shipped and verified."
It was broken: the producer flagged reviews the consumer **rejects**
(`isScoreable=false` — duplicates, consent-wall stubs), so `needsRescore` never
cleared and the queue accumulated stuck flags. The bug lived in the **seam**
between producer and consumer, which NO component test exercises. Only when the
user asked "did you fully test it?" did I run one real item end-to-end and find it.

**Why each green light lied:** unit tests verified the producer against its OWN
spec (does it flag the right reviews?). CI verified the step RUNS. Neither
verified the feature's PURPOSE — "a stuck review becomes fixed automatically" —
which requires the full producer→consumer→outcome chain. Verifying the parts is
not verifying the purpose.

**How to apply:**
1. **Test the seam, not the unit.** When a producer queues work for a consumer,
   take ONE real item, push it through the ACTUAL consumer, and assert the END
   state (here: `llm-v6 → anchored-v6`, in-band). If you can't produce a live
   example that heals end-to-end, you have NOT verified the feature — say so
   explicitly (backlog drained ≠ verified).
2. **The producer's admission predicate MUST import the consumer's**, never
   reimplement a subset. The late-star flagger hand-rolled
   `wrongShow||wrongProduction||isRoundupArticle` instead of the canonical
   `isIncludableForRebuild`/`isScoreable` the scorer uses. This is a REPEAT of
   [[feedback_includability_predicates_must_be_canonical]] — the rule already
   existed and I still violated it, which is the whole point of #3.
3. **Encode the seam as a standing invariant** so correctness doesn't depend on
   anyone remembering to test it. Here: `needsRescore===true ⟹ isScoreable`
   became `scripts/lib/stuck-rescore-flag.js` + `audit-stuck-rescore-flags.js`,
   wired into the non-blocking `check-corpus-drift.js` monitor. It immediately
   surfaced a **1170-flag pre-existing backlog** — the same class at scale from
   OTHER producers. A memory teaches future-me; a runtime invariant catches the
   whole class for every current and future producer without vigilance. Prefer
   the invariant when the property is machine-checkable.

Same "SET-without-re-evaluate / flag never re-cleared" family as
[[feedback_llm_v6_late_star_anchor_race]] and the wrongProduction stale-flag work.
