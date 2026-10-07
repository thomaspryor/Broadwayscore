---
name: audit-headline-count-is-unclaimed-bucket
description: "cross-production-audit.json \"1,159 Class A\" was the ambiguous/unclaimable bucket, not auto-fixable — verify an audit's schema before acting on a filter"
metadata: 
  node_type: memory
  type: project
  originSessionId: cd2f0aa7-e571-4862-9e38-9d222eaac868
---

When a task hands you an audit's headline count + a filter to "auto-fix" it, read the audit JSON schema FIRST — the count is often the bucket the audit deliberately *declines* to claim.

**Incident (2026-06-21):** Task said "Class A cross-production misattributions (1,159 open)" with filter `class==='A' && articleYear < showYear-5`. Those fields don't exist in `data/audit/cross-production-audit.json`. The real schema is `{file, publishDate, filedUnder, closerTo, urlYear, matchReason, confidence, hasDupeInCorrectDir}`, and the "1,159" was the `matchReason:'ambiguous' / confidence:'low'` bucket — reviews with NO parseable date, NO url-year match, NO venue match, `closerTo:null`. `audit-cross-production.js` records but does NOT claim them by design. Only ~29 issues had a concrete `closerTo` target; auto-flagging the 1,159 ambiguous would have excluded legitimate reviews wholesale.

**Why:** The audit's "issues" array mixes a tiny high-signal set (has a reassignment target) with a large "logged for the record, not actionable" set. The headline number is dominated by the latter.

**How to apply:**
- Before writing any auto-fix, `node -e` the audit and tally by `matchReason`/`confidence`; the auto-fixable set = items with a concrete target (`closerTo` set, `matchReason !== 'ambiguous'`).
- The genuinely actionable path for the ambiguous bucket is LLM-verify (read content, decide which production), not the deterministic audit — see `scripts/build-cross-production-classify-input.js` + `classify-wrong-production.js --provider=opus`.
- This is the [[feedback_investigate_premise_before_scaling]] pattern applied to audit outputs. Also relates to [[feedback_url_path_cross_production_sweep]].
