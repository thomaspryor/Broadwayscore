---
name: restore-protected-fields pattern
description: "Run restore-protected-fields.js after any rebase in push scripts."
type: feedback
originSessionId: d2eda523-f196-42c3-b414-122bae492488
archived: true
---
After any git rebase/merge/cherry-pick in push scripts, call `scripts/lib/restore-protected-fields.js <remote-ref>` to restore fields that conflict resolution silently dropped.

**Why:** Two incidents:
1. Becky Shaw opening night (2026-04-07) — `humanReviewScore`, `manualContentTier` lost 3 times by `-X theirs` rebase. 7-hour correction loop.
2. SERP cost reduction plan (2026-04-11) — ship-check reviewer caught that the new `serpDiscoveryAbandoned` fields (on 10,466 stuck review files) would be silently dropped by the content-aware merge in push-review-texts/action.yml when it picks "theirs" on files where their fullText is longer. Dropping those flags would unwind ~$200/mo of SERP savings.

**How to apply:**
- Already wired into `push-with-retry.sh` (80+ workflows), `push-review-texts/action.yml`, and `push-core-data/action.yml`.
- If adding a new push path, call `restore_protected_fields` after rebase.
- MANUAL_FIELDS list in `scripts/lib/restore-protected-fields.js` is now 12 fields covering two categories:
  - **(a) Manual human corrections:** `humanReviewScore`, `manualContentTier`, `wrongProductionManualClear`, `wrongProductionOverride`, `humanReviewedWrongProduction`, `allowEarlyDate`
  - **(b) Durable CI state:** `serpDiscoveryAbandoned`, `serpAbandonmentReason`, `serpAbandonmentDate`, `serpRetryCount`, `serpRetryAfter`, `wrongShowRetryAt`

**When to add a new field to MANUAL_FIELDS:**
- Human-set fields that CI pipelines should never touch: always add.
- CI-set fields: add if losing them unwinds significant work. `serpDiscoveryAbandoned` qualifies because dropping it = re-SERPing 10K+ files = $200/mo spend. `failureCount` on failed-fetches.json would qualify for the same reason.
- Do NOT add fields that are freshly computed every run (e.g., `wordCount`, `textFetchedAt`). Those are cheap to regenerate.

**The three-place sync rule:**
Any new field in MANUAL_FIELDS must also be added to:
1. `scripts/lib/review-write-guard.js` PROTECTED_FIELDS array (in-process writes)
2. `.github/actions/push-review-texts/action.yml` inline PROTECTED array (staged-vs-committed rebase protection)
3. `scripts/lib/restore-protected-fields.js` MANUAL_FIELDS (post-rebase restoration)

All three comments explicitly say "KEEP IN SYNC" with each other. Missing one of the three silently breaks the guarantee. Ship-check caught this for the SERP work.
