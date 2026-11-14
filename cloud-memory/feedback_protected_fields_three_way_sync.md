---
name: PROTECTED_FIELDS must stay synced across 3 locations
description: review-write-guard.js, push-review-texts/action.yml, and restore-protected-fields.js each carry a duplicate field list — drift silently drops overrides on rebase
type: feedback
originSessionId: 2261174c-b03c-4540-838b-ff1aae19d452
---
The opening-night protection fields (`allowTourSignal`, `allowFilmSignal`, `allowLateDate`, `allowCrossMarket`, `routedFromShowId`, `wrongProduction*ManualClear`, `wrongProductionOverride`, etc.) must be listed in THREE separate files or they get silently dropped during CI rebases.

**Why:** Each file runs in a different execution context:
1. `scripts/lib/review-write-guard.js` `PROTECTED_FIELDS` — enforced at write-time by `safeWriteReview()`. Protects ingestion/scoring/collection writes.
2. `.github/actions/push-review-texts/action.yml` `PROTECTED` inline JS — runs in GitHub Actions Node environment WITHOUT access to repo modules. Protects the pre-push "restore committed fields" pass.
3. `scripts/lib/restore-protected-fields.js` `MANUAL_FIELDS` — runs after `git rebase -X theirs` in `push-with-retry.sh`. Restores fields that the strategy dropped.

A field that's in only 1 or 2 lists will be silently dropped by the third.

**Beaches 2026-04-22 incident:** `allowTourSignal` / `allowFilmSignal` were NOT in any of the lists. The per-file `protectedFields` array workaround survived, but only because the Beaches ingest session set it explicitly — most future ingests wouldn't know to add it.

**How to apply:**
- When adding a new override field that opening-night-poller or ingest-manual-review sets, add it to all 3 lists simultaneously.
- Run `node --test tests/unit/protected-fields-sync.test.mjs` before shipping — it fails loud if any field is missing from any location.
- Do NOT attempt to refactor to a single source of truth without first solving the action.yml-can't-require-repo-modules problem (would need a generate-step that inlines the JS array into the YAML).

**Inverse direction also matters (2026-04-25):** drift can also go the OTHER way — action.yml accidentally INCLUDING a field that review-write-guard.js explicitly EXCLUDES. `incompleteReason` and `incompleteDetail` are derived (rebuild's classifyIncompleteReason re-computes them every run); review-write-guard.js:127 explicitly excludes them. action.yml had them anyway, silently restoring stale `wrong_content` flags after rebuild's clearing — blocked ~500 valid reviews from reviews.json. Fixed in commit 0052f4474f. Test `tests/unit/protected-fields-three-way-sync.test.mjs` guards this direction.

**Related:**
- `tests/unit/protected-fields-sync.test.mjs` — drift detector for missing-field direction (2026-04-23).
- `tests/unit/protected-fields-three-way-sync.test.mjs` — drift detector for accidental-inclusion direction (2026-04-25).
- `memory/feedback_per_file_protected_fields_lock.md` — per-file `protectedFields[]` lock as defense-in-depth.
- Postmortem: Beaches 2026-04-22 postmortem issue #6.
