---
name: feedback_wrong_production_durability_via_reason
description: "Making a wrongProduction flag survive rebuild — set wrongProductionReason, don't strip override fields, remediate after dates populate, set nested CV flag"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 57cf6326-93a3-4e72-910a-5bf0987a42a9
---

When manually flagging a review `wrongProduction: true` (contamination cleanup, opening-night corrections), the flag is reverted on the next rebuild unless done right. Four traps, learned the hard way (2026-06-21 operator-trust cleanup, ~4 wasted rebuild cycles; Notion 386637c5):

1. **Durability = `wrongProductionReason`, not stripping overrides.** `shouldAutoClearWrongProduction` (scripts/lib/wrong-production-autoclear.js) clears the flag on rebuild when `allowEarlyDate`/`allowCrossMarket` are present — but it short-circuits on `hasManualReason = !!wrongProductionReason`. So set a manual reason and the flag sticks **even with the poison override fields still present**.
2. **Don't fight the override fields.** `allowEarlyDate`/`allowCrossMarket`/`wrongProduction` are in the per-file `protectedFields` lock; rebuild's write-back and the push-time `restore-protected-fields.js` just re-add them. Stripping them is unwinnable — and unnecessary once a reason is set.
3. **Run date-based remediation AFTER a rebuild.** `publishDate` is backfilled *during* rebuild (from URL/content). Run the date guard before that and dated contamination is skipped as "no usable date." Sequence: rebuild → remediate → rebuild → validate.
4. **Set the nested CV flag too.** If the file has `contentVerification.wrongProduction: false`, the rebuild CV pre-pass promotes it and re-includes the review despite top-level `wrongProduction: true`. Set `contentVerification.wrongProduction = true` as well.

**Why:** the wrong-production/protected-fields/autoclear machinery has three independent revert paths (autoclear, protectedFields restore, CV pre-pass) plus a date-population dependency. Miss any one and the flag silently comes back on the next rebuild.

**How to apply:** prefer `scripts/fix-aggregator-gap-override-contamination.js` (encodes all four) over hand-edits. The systemic prevention for the operator-trust source is `operatorTrust:false` on `buildManualReviewFields` for automated callers ([[feedback_manual_review_protection_fields.md]], [[feedback_protected_fields_three_way_sync.md]]). Verify durability by rebuilding once and re-checking the flag before pushing.
