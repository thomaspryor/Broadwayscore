---
name: feedback_cv_wrongproduction_false_is_not_always_a_verdict
description: contentVerification.wrongProduction === false is NOT always an affirmative LLM verdict — heuristic/skip-short paths DEFAULT it to false; before trusting it (e.g. to skip a wrongProduction flag) require a production-aware verifier via verifiedBy (llm:/human/manual)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8972d744-dde4-48aa-bfa8-6c4e7221754a
---

`content-verifier.js` returns `wrongProduction: false` from MULTIPLE paths, only some
of which actually checked the production:
- `verifiedBy: 'llm:gemini' | 'llm:claude-haiku' | 'llm:openai'` — real LLM verdict.
- `verifiedBy: 'manual' | 'human:*'` — human verdict.
- `verifiedBy: 'heuristic'` / `'skip-short'` (and absent) — DEFAULTS. content-verifier.js
  literally comments "Heuristics can't reliably detect this" and returns `false` anyway.
  ~7% of all `cv.wrongProduction === false` rows (verified 121/1788 in a 7,800-file sample).

So `if (cv.wrongProduction === false) trustIt()` over-trusts the ~7% defaults. The
2026-06-23 ship-check caught this in `shouldSkipCrossShowUrlFlag`: deferring to bare
`=== false` would suppress legitimate year-distance wrongProduction flags on real
same-title sibling collisions (Streetcar 1988/2005, Arcadia, Enemy of the People) based
on a non-verdict. Fix: `isProductionAwareCvVerdict(cv)` — require
`cv.verifiedBy` to startWith `'llm:'` / `'human'` or === `'manual'`.

**Why:** CV is the project's STRONG signal and the right thing to defer to over weak
URL/date heuristics — but only when CV actually ran. A default masquerading as a verdict
is worse than no signal, because code trusts it.

**How to apply:** anywhere you read `contentVerification.wrongProduction` (or isValid,
wrongArticle, etc.) to make a decision, check `verifiedBy` too. Bare `=== false` is not
"verified correct"; it can be "we didn't/couldn't check." The promotion path in
rebuild-all-reviews.js already gates on `cv.confidence` + staleness for the same reason
([GUARD:CV-PRE-PASS] ~line 1479) — match that rigor when consuming CV elsewhere.

Related: the other ship-check finds that round — (a) a guard that SKIPS flagging a
shared-URL incumbent must also reject the incoming dupe + not re-home the URL index, or
both copies survive; (b) when you add a helper for a class (cross-show-URL year
heuristic), grep ALL setters of that class — cleanup-dedup-comprehensive.js (weekly cron)
and audit-cross-show-url-collisions.js catch-all were missed in the first pass and would
have re-introduced the false positives a week later.

Incident 2026-06-23 (Notion 386637c5-416f-81c7). Links:
[[feedback_value_first_delete_and_guard_symmetry]], [[feedback_aggregator_roundup_urls_shared_across_outlets]]
