---
name: feedback_prod_show_json_abbreviated_keys
description: "Prod /data/shows/{id}.json uses abbreviated keys (rv not reviews); never hand-parse, use scripts/show-status.js"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0cf9a96a-8567-444e-a617-d2cc5c1e199f
---

The production per-show file `https://broadwayscorecard.com/data/shows/{id}.json`
(and local `public/data/shows/{id}.json`) is the **slim/mobile format** written by
`scripts/generate-mobile-show-details.js`. Its keys are **ABBREVIATED**. Reading
`.reviews` returns `undefined` → treated as `0` → a false "reviews aren't live"
conclusion.

**Slim key map (top level):** `_v`=schemaVersion, `cat`=category, `cs`=criticScore,
`rc`=reviewCount, `bd`=scoreBreakdown, **`rv`=reviews[]**, `au`=audience,
`cn`=criticConsensus, `bo`=boxOffice, `hi`=heroImage, `pd`=previewsDate.
**Per review in `rv`** (only `assignedScore != null` reviews are emitted, so `rv`
== the scored-and-live set): `cn`=criticName, `o`=outlet, `s`=score, `b`=bucket,
`t`=tier, `u`=url, `d`=publishDate, `q`=pullQuote, `dg`=designation.

**Why:** On 2026-06-28 a session checked whether two LouReviews reviews were live by
curling the slim JSON and reading `.reviews` (which doesn't exist), got 0, and
falsely raised a "scored but not live" alarm — the shows actually had 24 and 11
reviews under `.rv`. The pipeline had worked. This is a recurring foot-gun.

**How to apply:** NEVER hand-curl/parse the prod or public slim show JSON to judge
coverage. Use `node scripts/show-status.js <show-id> [--critic="Name"] [--json]`
— it decodes the slim keys, compares local reviews.json vs prod, and answers
"is critic X live?". For programmatic use, `require('./scripts/show-status').decodeSlimShow(obj)`.
The full review object (with fullText/outletId) lives in `data/reviews.json`
(local, private data repo) and `data/review-texts/{id}/`, NOT in the slim file.
Related: [[feedback_e2e_runs_against_production.md]] (prod is the only "live" ground
truth), [[feedback_reviews_json_dual_repo_push.md]].
