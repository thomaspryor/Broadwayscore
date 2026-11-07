---
name: LBO has dual nature — aggregator AND first-party outlet
description: Sources that produce both pass-through aggregator content AND first-party byline reviews need scoring config that distinguishes the two. Subset of `lbo-individual` reviews are LBO's own editorial team and their stars are authoritative; `lbo-roundup` reviews are excerpts of other critics' work and downgrade applies.
type: feedback
originSessionId: 66add4a9-4817-4099-a620-3023958a503b
archived: true
---
LBO (London Box Office) is in `AGGREGATOR_SOURCES` because most of its content is roundup pages summarizing other critics. But LBO ALSO publishes first-party reviews by its own editorial team (Stuart King, Nicola Wright, Shehrazade Zafar-Arif) at `/news/post/{slug}` URLs. Those reviews carry an explicit `class="bstarsN"` rating — the critic's published star, not a relayed third-party score.

**Why this matters:** the WE-aggregator downgrade rule (rebuild-helpers.js `downgradeShowScore`) sends LBO scores through the LLM-from-text path instead of using the published stars. For roundup excerpts that's correct. For first-party bylines it produces "Mixed" displays for 4-star Stuart King reviews — which is what Stuart emailed about on 2026-04-25.

**How to apply:**
- The fix is `isLBOFirstParty = data.source === 'lbo-individual' && data.outletId === 'london-box-office'`. When true, exempt from `downgradeShowScore` and let `aggregatorStars` flow through `originalScore-priority0` (same path as KNOWN_STAR_OUTLETS).
- The split is by `data.source`, not `outletId` — both kinds of file have outletId='london-box-office'. The `source` field is what distinguishes `lbo-individual` (per-review byline page) from `lbo-roundup` (aggregator listing).
- **Generalize:** any source that produces BOTH first-party AND aggregator content needs the same source-field split. theatre.reviews has its own byline reviews (Aleks Sierz et al.) AND syndicates from elsewhere. WET (westendtheatre.com) ditto. Audit each before assuming aggregator-downgrade is universally correct.
- When wiring a new aggregator scraper, decide upfront: does this source publish first-party content too? If yes, use a distinct `source` value for those reviews so the scoring helper can branch. The LBO scraper got this right (`'lbo-individual'` vs `'lbo-roundup'`); the helper just hadn't been updated to use the distinction.

**Generalizable pattern:** when an extractor returns hardcoded `field: null` for a piece of content that the source page actually provides, that's a silent feature gap. `extractIndividualReviewFromLBO` returned `stars: null` for years even though every byline review page has `bstarsN`. Audit any extractor for hardcoded-null returns before declaring extraction complete.

Reference: scripts/lib/rebuild-helpers.js (`isLBOFirstParty`), scripts/scrape-london-box-office-roundups.js (`extractIndividualReviewFromLBO` — bstarsN regex). Notion 34e637c5-416f-81d5.
