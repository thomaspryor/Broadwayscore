---
name: rebuild-ignores-review-texts-dir-env
description: rebuild-all-reviews.js hardcodes data/review-texts; REVIEW_TEXTS_DIR env has no effect; two local clones exist
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0c8bb0c0-a9f6-4d9a-8394-ec169655091f
---

`scripts/rebuild-all-reviews.js` HARDCODES the source dir at line ~202:
`const reviewTextsDir = path.join(__dirname, '../data/review-texts')`.
It **ignores** the `REVIEW_TEXTS_DIR` env var. There are TWO local clones of the
private review-texts repo on this machine:
- `~/broadway-review-texts/` — the canonical clone CI checks out (commit+push here to ship via CI)
- `~/Broadwayscore/data/review-texts/` — a SEPARATE clone the local rebuild actually reads

**Why:** I edited review files in `~/broadway-review-texts/` and ran
`REVIEW_TEXTS_DIR=~/broadway-review-texts node scripts/rebuild-all-reviews.js` to
verify a wrongProduction-FP clear on giant-2026. The rebuild kept excluding the
files. I burned ~3 resume cycles assuming a guard was re-flagging them — the real
cause was the rebuild reading the OTHER clone (with the old flags). My edits were
correct; they just weren't in the dir the rebuild read.

**How to apply:** For a LOCAL rebuild to reflect review-file edits, apply them to
`~/Broadwayscore/data/review-texts/<show>/` (or `cp` the edited files there). For
the CANONICAL fix that ships, commit+push to `~/broadway-review-texts` (private
repo) — CI's rebuild checks that out. `git checkout -- data/review-texts/` RESTORES
files you deleted there (it's tracked-ish), so re-delete after a checkout.
Confirmed: `wrongProductionManualClear:true` IS honored — `shouldSkipWrongProductionAudit()`
(scripts/lib/review-guards.js) returns true for it, bypassing the CV-promotion and
cross-production guards. Related: [[feedback_review_texts_not_symlink]], [[feedback_manual_review_protection_fields]].
