---
name: spot-fix propagation failures
description: Every 'spot fix' during opening-night firefighting has layers of downstream propagation that can silently fail. Clearing a flag is NOT the same as restoring a record. Checklist for what to verify before declaring a fix 'done.'
type: feedback
originSessionId: 4e6d4130-c54b-4541-9cc8-a88f0fb67998
archived: true
---
When a review file or piece of data is broken during opening night and someone
applies a "spot fix", the fix almost always has 3-5 downstream steps that must
ALSO complete before the fix is actually visible. Each step can silently fail.
This is the single most common cause of "I thought we fixed it but the show
still doesn't look right."

# The propagation chain

For a review file to actually end up live on the site:

```
  source file edit (clear flag / add field)
         ↓
  commit in private review-texts repo
         ↓
  push to origin/main
         ↓
  collect-review-texts fetches fullText (if missing)
         ↓
  llm-ensemble-score assigns llmScore (if missing)
         ↓
  rebuild-all-reviews.js includes in reviews.json
         ↓
  commit + push reviews.json to broadway-scorecard-data repo
         ↓
  build public/data/shows/{id}.json
         ↓
  Vercel deploy
         ↓
  CDN cache invalidation
         ↓
  Live site reflects the change
```

Each arrow can fail silently. A fix at step 1 that doesn't reach step N is NOT
done.

# Specific failure modes observed

## 1. Flag cleared, but file has no text → still excluded
**Observed:** 2026-04-17 Proof LLM-FP rescue. Cleared `wrongProduction: true` on
4 files. `isIncludableForRebuild()` still returned `false` because the files
had `fullText: ''`. The flag clear only removes ONE exclusion gate; the text
absence is a DIFFERENT one.
**Fix:** Also re-fetch text (`fetchPage(url)` and write `fullText`) OR set the
file state so the next collect-review-texts run WILL re-fetch.

## 2. Text present, but no llmScore → still excluded
**Observed:** After fetching text manually, `isIncludableForRebuild()` still
returns false unless `llmScore` is present (OR aggregatorStars / originalScore).
**Fix:** Trigger llm-ensemble-score for the show OR wait for the auto-triggered
run. Don't assume scoring is instant.

## 3. Source edited, but rebuild hasn't run → reviews.json stale
**Observed:** Many opening nights. You edit a review-texts file, but
reviews.json doesn't update until rebuild-all-reviews.js runs and commits
to broadway-scorecard-data.
**Fix:** Explicitly dispatch `gh workflow run rebuild-reviews.yml` OR use the
fast-path poller which does rebuild inline.

## 4. reviews.json updated, but public/data/shows/{id}.json stale
**Observed:** The public per-show JSON is built separately. Can be out of sync.
**Fix:** The rebuild workflow includes `Regenerate mobile detail JSONs` step.
Verify it ran.

## 5. Deploy hasn't fired → live CDN still serves old state
**Observed:** push to private repo doesn't trigger Vercel deploy. Only
vercel-deploy.yml on the public repo does. You can push reviews.json updates
and see 0 change on live until the next public-repo push.
**Fix:** `gh workflow run "Deploy to Vercel" -f production=true` after private-
repo data changes.

## 6. Vercel edge cache still serving old JSON
**Observed:** After deploy, ~1-5 min of CDN propagation before live JSON shows
new fields. Can look like the fix didn't work when it did.
**Fix:** Wait OR hit with `?cache-control: no-cache`. The drift detector's
`fetchLiveRc` uses `cache-control: no-cache` — model after it.

## 7. Flag cleared at file level, but collect-text may re-flag
**Observed:** contentVerification LLM in collect-review-texts runs at fetch
time and can re-set `wrongProduction: true` with `confidence: high`. Even if
you cleared the flag, the next collect cycle may re-flag.
**Fix:** Set `wrongProductionManualClear: true` AND
`humanReviewedWrongProduction: false` (nuclear overrides honored by
`shouldSkipWrongProductionAudit`). Verify by reading
scripts/lib/review-guards.js:447.

## 8. Commit in private repo, but public-repo CI didn't see it
**Observed:** 2026-04-17 audit-contamination topdog delete. Pushed to
broadway-review-texts. But Test Suite on Broadwayscore main didn't re-run
because there was no push to main. The audit stayed "failing on main" until
the next public-repo push re-triggered Test Suite.
**Fix:** After private-repo edits that affect CI, trigger a trivial public-
repo push or manually dispatch Test Suite.

## 9. Manual edit overwritten by workflow
**Observed:** Historical — manual humanReviewScore set, next rebuild pass
clobbered it because the field wasn't in PROTECTED_FIELDS.
**Fix:** Per-file `protectedFields` array (Structural #5 shipped 2026-04-16)
or confirm PROTECTED_FIELDS global includes the field.

## 10. "Poller will pick it up" assumption
**Observed:** The opening-night-poller runs every 10 min (as of 2026-04-16).
But it only processes certain file states. If a file is already present with
`fullText` set, poller's collect step skips it. If you want re-fetch, you
must clear both `fullText` and `fetchAttempts`.
**Fix:** Check the conditions under which the poller's inline collect step
will re-process a file. Don't assume passive cron runs will fix a partially-
broken state.

## 11. wrongProductionOverride set, but `isNonReview: true` still excludes
**Observed:** 2026-04-24 WE long-runner cleanup. Cleared `wrongProduction` on
8 files via `wrongProductionOverride: true`. 7 landed in reviews.json;
mamma-mia/variety--matt-wolf did not — `skippedNonReview` exclusion fired
instead. The file had `isNonReview: true` with `nonReviewType: "feature"`
set by `scripts/classify-non-reviews.js` on an earlier run (gemini FP —
CV.articleType was "review", LLM ensemble scored 56).
**Fix:** When clearing wrongProduction on a file, also check
`isNonReview`, `wrongShow`, `isRoundupArticle`, `rejectedAt`, `duplicateOf`,
and `contentTier === 'invalid'`. Each is a separate exclusion gate in
`scripts/rebuild-all-reviews.js` (grep `logExclusion` — ~15 reasons).
Clearing one doesn't clear the rest.

# Checklist before declaring a spot fix "done"

- [ ] Did the edit get written to disk? (read file back, verify)
- [ ] Did the edit survive any concurrent workflow? (diff before + after)
- [ ] Is the file in a state where downstream pipeline WILL re-process it?
- [ ] Is `isIncludableForRebuild()` TRUE for this file now? (run the helper)
- [ ] Did collect-review-texts / llm-ensemble-score actually run on it?
- [ ] Is the review now in reviews.json? (grep)
- [ ] Is the review now in public/data/shows/{id}.json? (grep)
- [ ] Did a deploy run since the change?
- [ ] Is the live CDN (with cache-busting) serving the new state?

Every unchecked box = "fix looks done but isn't."

# Why this matters for post-mortems

When writing an opening-night postmortem, document:
1. WHAT spot fix was applied
2. WHICH of the 10+ propagation steps above was the actual breakage
3. WHETHER the fix was verified at each step or assumed

Postmortems that say "we applied fix X" without tracing the propagation chain
are the reason the NEXT opening hits the same class of bug. The fix was
applied but the bug class wasn't generalized because nobody mapped the chain.

Tonight (2026-04-17 Proof) examples:
- LLM-FP rescue needed 3 steps (flag clear → text fetch → score)
- Audit-contamination fix needed public-repo push to re-run CI
- Stub writes happen at file-create, but need collect → score → rebuild → deploy
  before showing up live

# Related memory
- feedback_llm_wrongprod_false_positives.md — the specific LLM-FP bug class
- feedback_verification_gate_hook.md — Stop hook enforcement
- opening_night_workarounds.md — documented procedural fixes
