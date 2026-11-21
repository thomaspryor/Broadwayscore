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

**How to apply:** intentional clears set a `duplicateClearReason` breadcrumb (both review-write-guard self-heal and the audit `--fix` do this). The restore skips duplicateOf/duplicateReason when that breadcrumb is present AND the field is empty.

**GENERALIZED 2026-06-05 (P1):** the duplicateOf-only carve-out was the same bug for EVERY manual-clear family — a heal nulls/deletes a PROTECTED flag, restore (both `action.yml` inline node AND `scripts/lib/restore-protected-fields.js`) sees the empty value as data-loss and resurrects the stale flag, re-flagging a human-verified review. Now a single `isIntentionalClear(field, data)` + `CLEAR_BREADCRUMBS` map exported from `review-write-guard.js` is the source of truth, wired into both restore sites: wrongProduction (canonical triplet `wrongProductionManualClear`/`wrongProductionOverride`/`humanReviewedWrongProduction:false`), wrongShow (reuses `wrongShowCleared` from review-guards.js via lazy require), wrong-article, originalScore (`originalScoreCleared`), plus duplicateOf. Predicates MIRROR review-guards.js canonical is-cleared semantics — do NOT add `wrongProductionAutoCleared`/`wrongShowAutoCleared` (string-typed, flag set `false` not deleted; canonical ignores them). Locked by `tests/unit/intentional-clear-breadcrumb.test.mjs` (every breadcrumb key must be an actual PROTECTED_FIELD). Gotcha caught in ship-check: `*/` inside a JSDoc comment ("wrong*/originalScore") silently closes the comment → syntax error. General rule: any time a scheduled heal "runs green but nothing changes," check the push-action protected-field restore against what the heal nulls. See [[feedback_protected_fields_three_way_sync]], [[feedback_duplicate_of_url_mismatch]], [[feedback_includability_predicates_must_be_canonical]].
