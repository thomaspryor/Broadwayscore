---
name: NY Post star widget launched mid-2020, not 2019
description: NY Post's rating__star--filled CSS widget (extractNYPostScore target) has no data before 2020-06-30. 2019 and earlier NYP theater reviews are pure text — don't try to extract stars from them.
type: reference
originSessionId: da56c300-b775-46c0-8002-605c96f23b84
archived: true
---
The comment in `scripts/lib/score-extractors.js:485` says "NY Post uses CSS star widgets on newer articles (2019+)." This is wrong by about a year. Empirically verified 2026-04-24:

- Earliest successful `css-stars` extraction in the entire corpus: **Hamilton filmed version, 2020-06-30**
- Focused backfill on 19 fullText-only NY Post articles from 2019: **0/19 recovered** (all fetched 400-500K chars of real HTML; extractor found no widget)
- Only post-widget 2026 article in that set recovered

## When this matters
- If you're auditing "why is this NY Post review unscored" — pre-2020 articles have no star to extract. llmScore is the only path. Don't run Phase 3 of recover-explicit-ratings.js on them; it's wasted HTTP calls.
- If you're expanding KNOWN_STAR_OUTLETS or building new recovery scripts — filter NY Post candidates by `url.match(/nypost\.com\/20(2[0-9])\/\d{1,2}\/\d{1,2}/)` (URL date ≥ 2020) before attempting widget extraction.
- Of the 226 NY Post fullText-only files in the current corpus (per isScoreable), 225 already have llmScore. The gap the parent card (34b637c5-416f-81fc-8c87-ef7840a91e86) worried about doesn't exist at scale — llmScore already covers pre-widget reviews.

Fix card open for updating the comment: see Notion brain for "Fix extractNYPostScore doc".
