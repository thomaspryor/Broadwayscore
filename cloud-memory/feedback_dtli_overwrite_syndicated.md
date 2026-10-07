---
name: DTLI scraper overwrites syndicated-duplicate files
description: extract-dtli-reviews.js and gather-reviews.js can silently clear isSyndicatedDuplicate when findExistingReviewFile skips duplicateOf files
type: feedback
originSessionId: 3c6ff3c4-f1a0-4c7d-b918-ec1e69601bf4
archived: true
---
Any script that (1) calls findExistingReviewFile() to find existing review files AND (2) writes to the canonical path when no match is found will silently overwrite files with isSyndicatedDuplicate/duplicateOf — because findExistingReviewFile intentionally skips files with duplicateOf (they're not merge targets).

**Why:** findExistingReviewFile in review-normalization.js line 1126 skips `duplicateOf` files. extract-dtli-reviews.js hit this on 2026-04-19 for proof-2026/nydailynews--chris-jones.json, clearing isSyndicatedDuplicate=true and causing Chris Jones to be double-counted as a T1 review.

**How to apply:** When writing a new script (or auditing an existing one) that writes review files to show directories, add a guard before the findExistingReviewFile lookup:
```js
if (!overwrite && fs.existsSync(filepath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    if (existing.isSyndicatedDuplicate === true || existing.duplicateOf) {
      return null; // Skip — preserves manual dedup flags
    }
  } catch { /* fall through */ }
}
```
See commit 7e80c20463 in extract-dtli-reviews.js for the exact pattern.
gather-reviews.js has this risk unfixed (Notion card 347637c5-416f-81cd-8c16-dcbfe53d2ea9).
