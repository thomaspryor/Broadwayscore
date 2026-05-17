---
name: wrongProduction audit must check all reason fields
description: "Check 9 legacy field variants, not just wrongProductionReason."
type: feedback
originSessionId: 49e1818d-b835-4c9b-b509-9aa0c044b012
archived: true
---
Any audit looking for "silently dropped" reviews (wrongProduction=true with no recorded reason) must check ALL of these fields before concluding a file has no diagnostic:

- `wrongProductionReason` — canonical, used by rebuild-all-reviews.js CV pre-pass
- `wrongProductionNote` — legacy, used by most rebuild guards (pre-opening, cross-market, URL-year, cross-show URL, date-guard)
- `_wrongProductionReason` — underscore-prefixed, used by cleanup-dedup-comprehensive.js
- `_wrongProductionDetectedBy` — underscore-prefixed, used by cleanup-dedup-comprehensive.js
- `incompleteReason` — commonly set to `'wrong_content'` alongside the flag (treat as generic)
- `incompleteDetail` — commonly set to `'Wrong production'` (treat as generic)
- `contentTierReason` / `tierReason` — echoed classification string, also generic
- `llmReason` + `llmClassified` — set by scripts/classify-wrong-production.js
- `movedReason` — set when a file was moved between show directories

**Why:** During the 'Recover wrongProduction false positives' card (Apr 11 2026), an initial audit that only checked `wrongProductionReason` found 2,071 "reason-less" files and extrapolated 722 recoverables. A tightened audit that checked all fields above found only 684 truly reason-less files — the vast majority had reasons, just in legacy fields. Recovering the wrong 722 would have re-introduced real wrong-production reviews into composites.

**How to apply:** When writing a new audit script, put all reason-like fields in a `GENERIC_REASONS` set (strings that mean "no diagnostic, just echoing the flag") and a `hasDiagnosticReason()` helper that returns true if ANY non-generic string is present in ANY of those fields. See `scripts/one-off/audit-wp-cv-valid.js` for the canonical pattern.
