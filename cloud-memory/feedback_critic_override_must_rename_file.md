---
name: HC author override must rename the file
description: When a critic-enrichment branch overwrites data.criticName, the file path must be renamed to match the new slug — or validate-review-texts.js eventually fires a (outletId+criticName) duplicate against a sibling whose filename matches the new slug. Fixed in scripts/collect-review-texts.js 2026-04-26 / PR #290 by extracting renameReviewFileToMatchCritic into scripts/lib/review-normalization.js and wiring it into all 3 enrichment branches.
type: feedback
originSessionId: b6a704a3-5376-45c7-81c7-278d73573ee3
archived: true
---
When `data.criticName` is overwritten on a review-text record after load, the file on disk must follow. The slug *is* the identity, even when no schema declares it. Three branches in `scripts/collect-review-texts.js:updateReviewJson()` overwrite criticName: HC author override (1A-bis, around line 4599), byline cross-check confirmed by HC (1B, ~4647), and Unknown→real-name enrichment (1B-iii, ~4686). Pre-2026-04-26, only 1B-iii renamed the file; the other two left it at the old slug. When a sibling file with the new slug already existed, `scripts/validate-review-texts.js` fired a same-outlet+critic duplicate error and CI red'd. Real incident: cats-the-jellicle-ball-2026/variety on 2026-04-26.

**Why:** The slug *is* the identity in this catalog (file basename, llm-scores sidecar, duplicateTextOf pointers, both repos). When a downstream writer changes the in-memory criticName but not the file, every reader that locates the file by slug starts diverging from every reader that reads the file's body. Validation is one of those readers.

**How to apply:**
- Any new code path that overwrites `data.criticName` post-load must call `renameReviewFileToMatchCritic(review.filePath, data)` from `scripts/lib/review-normalization.js` and update `review.filePath` from the result. The helper handles dest-doesn't-exist (rename) and dest-exists (merge unique fields, delete source).
- Same rule for any catalog-wide backfill (`scripts/backfill-*.js`) that touches criticName: don't write the field without updating the path. Add the script to `.review-write-guard-exempt.txt` if it's a topology mover.
- When auditing a class of bug like this, **also** count siblings with `criticEnrichedFrom: html-override:*` and slug-mismatch — they're the latent reservoir.
- **Caveat:** the override that triggers the rename can fire on a wrong-URL fetch (`contentVerification.wrongShow=true` etc). 7 of 8 cases found in the 2026-04-26 audit were corrupt-source. The backfill must skip corrupt sources or it propagates junk flags into clean destinations. Check `wrongShow`, `wrongProduction`, `wrongUrl`, `wrongAttribution`, `contentTier === 'invalid'`, `contentVerification.wrongArticle`, `contentVerification.wrongProduction`. The 1A-bis override should arguably also gate on these, but that's a separate fix.
