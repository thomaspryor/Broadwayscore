# duplicateTextOf as an audit skip (BRO-2613)

BRO-74 fixed `audit-review-contamination.js` C2, which treated `duplicateOf || duplicateTextOf`
as proof a file is not scored. That claim is false: `rebuild-all-reviews.js` applies
`duplicateTextOf` conditionally (`scripts/lib/duplicate-of-exclusion.js`
`duplicateTextOfDecision`): a stale, missing, circular or itself-excluded reference lets the
file through into scoring.

Four other sites use the same skip. Verdict: safe as is.

| Site | What the skip means | Claim made |
|---|---|---|
| `audit-review-duplicates.js` outlet-as-critic grouping | leave the file out of the "same outlet, several critics" cluster search | none about scoring |
| `audit-review-duplicates.js` URL-domain mismatch | leave the file out of the outlet/domain check | none about scoring |
| `audit-opening-night-extraction.js` `auditCriticCollisions` | do not report a critic collision for a file already marked as a duplicate | none about scoring |
| `audit-url-collisions.js` `--fix` | do not overwrite an existing `duplicateOf`/`duplicateTextOf` when pointing a colliding file at its canonical | none about scoring; a stale link is left for the flag-inheritance audit |

The first three only decide whether to raise a new finding; the fourth only avoids clobbering
an existing link. None says "this file cannot be a bug because it is excluded from scoring",
and none changes a score.

Known limit: a file whose `duplicateTextOf` is stale (so rebuild scores it anyway) is not
examined by these checks. The same file is still covered by the text-duplicate check that
created the `duplicateTextOf` link, and by C2 in `audit-review-contamination.js`, which reads
`reviews.json` for ground truth (`scripts/lib/c2-live-scored-check.js`). If a miss is ever seen,
use that helper rather than re-implementing the rebuild conditions in the audit.

`scripts/audit-review-duplicates.test.mjs` pins the call sites to this note.
