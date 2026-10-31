---
name: feedback_js_array_gt_comparison
description: "JS gotcha: array > 0 is always false — arrays coerce to NaN for non-numeric content. Use Array.isArray + .length."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4d639da5-c2de-4d9e-81ac-d96e0b886f15
---

`array > 0` is always false in JS for string arrays because JS coerces to NaN (not 0). The `|| 0` fallback doesn't help either.

**Why:** `scripts/audit-tony-eligibility.js` had `const wins = tony.wins || 0` then `if (... || wins > 0)`. Since `tony.wins` is `string[]` (category names like 'Best Musical'), `wins > 0` was always false — silently breaking the contradiction detector for any show with wins for the entire time the wins field existed.

**How to apply:** Whenever comparing an array field for "has any items", always use `Array.isArray(x) ? x : []` + `x.length > 0`. Never compare arrays with `>`, `<`, `>=` directly — even if you set a numeric default via `||`.
