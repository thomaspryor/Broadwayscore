---
name: Sticky-once for "what did the model say before any human touched this"
description: priorScoreAtLock-style audit fields must be set ONCE on first lock and never overwritten on re-lock; otherwise the second lock records the previous lock's value as the "model's prior score" and the original-model-score signal is lost forever.
type: feedback
originSessionId: ea80a0ca-1079-4860-a70a-9e06aff61f83
archived: true
---
**Rule:** Audit fields whose semantic is "what did X think before the FIRST human override" must use sticky-once semantics on disk. On re-lock, read the existing value and preserve it; only write when the field is unset.

**Why:** Rebuild's `getBestScore` returns `humanReviewScore` at P0, which means `llm-ensemble-score.js` skips human-locked files. So `existingData.llmScore.score` IS the prior locked value on every re-lock — it's NOT the model's read between locks. Capturing `priorScore = existingLlm.score` and then writing it back as `priorScoreAtLock` produces a self-referential value: the second lock records the previous lock's score as "what the model thought." The original-model-score signal vanishes the moment anyone re-locks.

**How to apply:**
```ts
const stickyPriorScore =
  typeof existingData.priorScoreAtLock === 'number'
    ? existingData.priorScoreAtLock
    : existingLlmScore;
// ... later, when writing:
if (stickyPriorScore !== null && typeof existingData.priorScoreAtLock !== 'number') {
  merged.priorScoreAtLock = stickyPriorScore;
}
```

**Detection:** Caught in /ship-check on the lock-score audit-trail feature (Lost Boys 2026-04-27). The Codex/Claude adversarial review specifically asked "what's the cyclic-priorScore failure mode" and traced it through the rebuild precedence chain.

**Generalizes to:** Any audit field describing "the state before the first manual change." Examples: `originalScoreBeforeAdjudication`, `firstObservedAt`, `discoveryUrl`. If the read-back path is ALSO the human-overridden field, sticky-once is mandatory.
