---
name: Engine critic-level dedup (was outlet-level until 2026-04-11)
description: "computeCriticScore dedups by (outletId, criticName) with 1/N weights."
type: feedback
originSessionId: 3b81d67c-5a1d-4d9f-8921-9cecafecb56e
archived: true
---

`computeCriticScore` in `src/lib/engine.ts` (and the parallel `scripts/lib/compute-critic-score.js`) dedups by `(outletId, criticName)` — NOT by outletId alone. As of 2026-04-11 (commit `accdbbb333`), multi-critic outlets like NYSR, NYT, Variety, Vulture, EW, TheaterMania, WSJ, TalkinBroadway all keep ALL their distinct critics. Same critic re-reviewing (e.g. after a cast change) still dedups to the most recent.

To preserve the "one outlet = one tier vote" intent, each critic's effective weight is divided by the count of distinct critics that outlet has on this show. NYSR with 3 critics → each contributes (1/3) × T2 weight, summing to NYSR's full T2 vote. Mathematically equivalent to averaging within outlet then tier-weighting.

**Why this memory exists:** Before 2026-04-11, the dedup was outlet-level, silently dropping ~530 legitimate critic reviews across 373 shows. I tried to recover Frank Scheck's NYSR DoaS pull quote (broadway-review-texts commit `7a98160e6`) and verification showed it never reached the schema — David Finkle's review (also NYSR, also score 100, alphabetically first) was the dedup winner. The fix taught us the dedup was actively hiding critic disagreement: going-bacharach's score dropped 6.17pts (79.8 → 73.7) when Elysa Gardner's hidden Negative review surfaced.

**How to apply:**

1. **Per-review fixes target specific (outletId, criticName) pairs.** Both critic name and outlet name are part of the dedup key — fixing the "wrong" critic at the same outlet is no longer silently wasted work, it just goes to a different vote slot.

2. **Multi-critic outlet weight is `1/N × tierWeight`** where N is the count of distinct critics that outlet has on this show. If you're computing your own weighted score outside the engine (e.g., a one-off audit script), include the outletShare divisor or your math will diverge from `show.criticScore.score`.

3. **Long-running shows still need same-critic dedup.** A critic may re-review after a cast change. The dedup keeps the most recent by publishDate within the same `(outletId, criticName)` group.

4. **`reviewCount` semantics changed.** Before: count of distinct outlets. After: count of distinct (outlet, critic) pairs. A show with NYSR-3-critics + 5 solo outlets will report `reviewCount: 8`, not 6.

5. **Test suite enforces this.** `tests/unit/compute-critic-score.test.mjs` has 6 tests covering multi-critic-outlet behavior. The gold-list parity test asserts engine.ts and scripts/lib agree on real shows. Don't change one without the other.

Audit query for finding multi-critic-outlet cases:
```js
const byKey = {};
for (const x of reviews) {
  const k = x.showId + '|' + x.outletId;
  (byKey[k] = byKey[k] || []).push(x);
}
for (const [k, list] of Object.entries(byKey)) {
  const distinctCritics = new Set(list.map(x => x.criticName).filter(Boolean));
  if (distinctCritics.size >= 2) console.log(k, '→', distinctCritics.size, 'critics');
}
```
