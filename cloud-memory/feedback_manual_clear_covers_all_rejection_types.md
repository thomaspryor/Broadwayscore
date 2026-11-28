---
name: Manual-clear flags must cover all LLM rejection types symmetrically
description: When a manual-clear carve-out is added to wrong_production, extend the same logic to wrong_show, not_a_review, and garbage_text — the LLM ensemble can pivot between rejection types.
type: feedback
originSessionId: f6db618e-65be-467b-86e4-545db1fefd5b
---
When adding a `wrongProductionManualClear`/`humanReviewedWrongProduction` carve-out to one exclusion guard (e.g. `isIncludableForRebuild` rejectedAt, wrongProduction), extend it symmetrically to `wrongShow` and any other LLM-set rejection flags.

**Why:** The LLM ensemble's scoreability-check picks among `wrong_show`, `wrong_production`, `not_a_review`, `garbage_text`. When one rejection path is blocked, a re-scored file can come back with a DIFFERENT rejection type. The 2026-04-23 Giant case: cleared `wrongProduction` + set `wrongProductionManualClear=true`, LLM then re-rejected the same file with `wrong_show` ("Mark Rosenblatt play, not the Giant musical I know"), setting `wrongShow=true`. My first fix only covered the wrongProduction path; the file stayed excluded until I added the same carve-out to `wrongShow`.

**How to apply:** When patching `isIncludableForRebuild` or `scripts/llm-scoring/index.ts:1196-1213` rejection routing, grep for the sibling rejection types and replicate the manual-clear check. Test with a case that flips from one type to the other.

Pattern — guard check in `scripts/lib/review-guards.js`:
```js
if (data.wrongShow === true) {
  const cleared =
    data.wrongShowManualClear === true ||
    data.wrongShowOverride === true ||
    data.wrongProductionManualClear === true ||    // ← cross-flag: prod clear implies show correct
    data.wrongProductionOverride === true ||
    data.humanReviewedWrongProduction === false;
  if (!cleared) return false;
}
```

Pattern — llm-scoring skip at `scripts/llm-scoring/index.ts`:
```ts
if (manuallyCleared && (rejection === 'wrong_production' || rejection === 'wrong_show')) {
  skipped++;
  continue;
}
```
