---
name: audit-review-contamination-strict-mode-is-a-separate-ci-gate
description: "audit-review-contamination.js --strict is a SEPARATE CI step from validate-data.js. Both must pass. Strict classes A (cross-market), B (false-positive wrongProduction), C (domain mismatch) fail CI."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0fc535b0-5090-4ae5-bb2a-50b4728216a7
---

`scripts/audit-review-contamination.js --strict` runs as a separate step in the Data Validation CI job (`test.yml` line 762), AFTER `validate-data.js`. A passing `validate-data.js` does NOT mean the Data Validation job passes.

**Strict classes that fail CI:**
- `A_cross_market`: Broadway reviews in WE show dirs or vice versa
- `B_false_positive_wp`: `wrongProduction:true` AND `contentVerification.wrongProduction:false` AND pubDate within 30 days of showOpening — means the date guard fired but the LLM confirmed the review is for this show
- `C_domain_mismatch`: Review URL domain doesn't match the outlet's known domain

**Class B gotcha:** Fires when `wrongProduction:true` AND `contentVerification.wrongProduction:false`. The LLM verified content IS for this show, but the date guard disagrees. Fix: clear `wrongProduction` from the file (it's a false positive). Commonly affects productions that share opening dates across runs (e.g., a show with openingDate=2011-11-24 that got a "west-end-2021" slug but kept the 2011 date).

**Why:** Caught 2026-05-20: `matilda-the-musical-west-end-2021/thestage--lisa-martland.json` — Stage review published 9 days before 2011-11-24 previews, wrongly flagged by date guard. Show has openingDate=2011-11-24 (same year), so the review IS for this production. Fix: clear `wrongProduction` + `wrongProductionNote` from the private repo file.

**How to apply:** When Data Validation fails in CI but local `validate-data.js` passes, run `node scripts/audit-review-contamination.js --strict` locally against the REMOTE private repo content (pull first). Check `B_false_positive_wp` count.
