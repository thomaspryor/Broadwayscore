# BRO-3794 — "BSC Daily: Main: red streak" — session state

Branch `job/linear-BRO-3794-mub66uiw`, pushed to origin at bfd2cfdc44f.
NOT merged to main: the pre-merge review gate requires a recorded /ship-check
verdict and the session hit its time budget first.

## What the red streak actually was

Three INDEPENDENT failures, not one. Reproduced from run 35565674653.

### 1. Data Validation → "Audit outlet-registry gaps"  — RACE, self-healed
`thereporttoday--unknown.json` (a /submit-review UGC submission for
the-cherry-orchard-park-avenue-armory-off-broadway-2026) was ingested at
05:36, CI ran the registry audit at 05:49, and the ensemble-scoreability
check rejected it as `not_a_review` at 06:18. For those 42 minutes the file
was a live review from an unregistered domain, so `--strict` failed.

`isExcludedFromOutletRegistryAudit()` already excludes it correctly now
(verified against the real file). NOT fixed: any UGC submission from an
unregistered domain still reds main's trunk for the window between ingest
and adjudication. **This is user-triggerable CI breakage.** See "Remaining".

### 2. E2E → biz-data-functions.test.mjs — FIXED AND VERIFIED
`torch-song-2018` landed in commercial.json with no `designation` field.
Root cause: `buildCommercialEntry`'s `if (designation)` write silently
dropped it when deep research returned no designation.
Fixed at three levels (commit cc4eb27a31e) + data backfill (data repo
ecb7ac2f0). `node --test tests/unit/biz-data-functions.test.mjs` → 25/25.

### 3. E2E → review-gap-remediation.test.mjs — REMEDIATED, awaiting CI snapshot
`disruption-off-broadway-2026` had 2 unrecovered gaps. Root cause is a
DEADLOCK between two guards:
  - lib/url-ownership.js: refuse a 2nd copy of a URL under another show
    unless the owning copy is already `isCombinedReview`
  - flag-combined-reviews.js: set `isCombinedReview` only once the URL
    appears under 2+ shows
A genuine multi-show roundup collected for show A first can NEVER be
collected for show B. 502 corpus URLs are in that state.

Remediated the 2 Disruption URLs by hand (review-texts 767b3ab97e0, on
origin): stamped both owners `isCombinedReview`, ingested Disruption's
copies, stamped those.

**The test will stay red until `audit-aggregator-gap.yml` regenerates
`data/audit/show-review-gap.json`** — the test pins that committed snapshot,
and this session cannot regenerate it without a full aggregator re-audit.

## Also fixed along the way (both found while closing #3)

- `scripts/lib/article-extractor.js`: the generic common-class fallback
  hardcoded `class="…"` (double quotes only), so every Blogger/Blogspot
  outlet extracted 0 chars even though `post-body`/`entry-content` were
  already in GENERIC_CONTENT_CLASSES. 0 → 10,591 chars on the real page.
- `scripts/ingest-review-from-url.js` + `scripts/flag-combined-reviews.js`:
  both defaulted the review-texts root to a `__dirname` join, which from a
  worktree points at a nonexistent path — the script then mkdir -p'd an
  untracked dir, wrote the review, printed "✅ Created", and the file
  belonged to no repo. Now use `resolveReviewTextsDir()`.

## Remaining

1. **Merge this branch.** Needs /ship-check first (pre-merge gate, by design).
   `git checkout main && git pull && git merge job/linear-BRO-3794-mub66uiw`
   then `bash scripts/lib/push-with-retry.sh`.
2. **Verify #3 went green** after the next audit-aggregator-gap.yml run:
   `node --test tests/unit/review-gap-remediation.test.mjs`
3. **File/fix the UGC registry race (#1)** — a submitted review from an
   unregistered domain reds main until adjudication. Options: exclude
   un-adjudicated `submit-review-form` files from the `--strict` gate, or
   don't write the file until the scoreability check has run.
4. **Decide the 502-URL deadlock backlog.** The capability ships OFF:
   `node scripts/flag-combined-reviews.js --use-aggregator-citations --dry-run`
   Turning it on newly flags 166 files `isCombinedReview`, which exempts each
   from the cross-show contamination guards. Most are genuine roundups; some
   are the opposite (show A holding show B's review by mistake) and flagging
   those would HIDE contamination. Needs a human call, hence default-off.

## Acceptance command
`node scripts/check-health-row-absent.js --row-b64 TWFpbjogcmVkIHN0cmVhaw`
Will not pass until #3's snapshot regenerates and the branch lands.
