---
name: push-review-texts-reverts-intentional-clears
description: push-review-texts restore reverts duplicateOf heal clears because duplicateOf is a PROTECTED_FIELD
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 195cd6dd-f7dc-488c-865c-c5faf430e356
---

The `clear-stale-duplicate-of` heal (and `audit-duplicate-of-url-mismatch --fix`) could NEVER persist a flag clear: `duplicateOf`/`duplicateReason` are in `PROTECTED_FIELDS` (scripts/lib/review-write-guard.js), so `.github/actions/push-review-texts/action.yml`'s restore step saw the nulled field as "data loss" and restored the old value — logging `Protected N review(s) from data loss` and pushing nothing. The test.yml "Audit stale duplicateOf flags" gate stayed red indefinitely no matter the heal cadence (a weekly→daily cron change did nothing on its own).

**Why:** the restore loop only checked `committedHasContent && localIsEmpty` — it had no notion of a *deliberate* clear, so an intentional null looked identical to data loss.

**How to apply:** intentional clears set a `duplicateClearReason` breadcrumb (both review-write-guard self-heal and the audit `--fix` do this). The restore now skips duplicateOf/duplicateReason when that breadcrumb is present AND the field is empty (locked by `tests/unit/push-review-texts-restore-dupclear.test.mjs`). General rule: any time a scheduled heal "runs green but nothing changes," check the push-action protected-field restore against what the heal nulls. See [[feedback_protected_fields_three_way_sync]], [[feedback_duplicate_of_url_mismatch]].
