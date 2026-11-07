---
name: opera-multi-house-discovery
description: How non-Met opera houses (ROH done) get premieres discovered, labelled and reviewed; checklist for adding Chicago, LA, SF, Glyndebourne (BRO-6766)
metadata:
  type: project
---

Owner scope (2026-11-01): premieres and new productions only at a few major houses; no full seasons, no revivals.

**Done (BRO-6766):** Royal Opera House. Shows are `type: opera`, `venue: Royal Opera House`, `category: off-west-end`, `market: west-end`. Parsing in `scripts/lib/roh-opera-discovery.js` (rbo.org.uk listing + production pages); `discover-opera-shows.js --house=met|roh|all`. Weekly dry run in `.github/workflows/discover-opera-shows.yml` (Mon 11:17 UTC). Write runs are manual: dispatch with `dry_run=false`.

**Adding a house (checklist):**
1. Pure parser in `scripts/lib/<house>-opera-discovery.js` plus a `.test.mjs` on saved HTML; wire into `discover-opera-shows.js` behind `--house=`.
2. Venue label + duration suffix + `is<House>Venue` in `src/lib/show-market.ts` (see ROH/ENO/SFO); new id prefixes in `src/lib/opera-show-ids.ts`.
3. House URL markers in `site-search-discovery.js` (`operaHouseForVenue`) so its own reviews are not rejected as "other house".
4. Cross-check each stub with `scripts/validate-show-venue.js`; mark `provisional: true`.
5. Outlets: opera outlets gate on `show.type === 'opera'`, so they fire for any house. UK outlets are market-gated (west-end). Not covered by site search: FT (403), Opera magazine (site unreachable); they arrive via SERP/Google News layers.

**Follow-up evaluation (separate card):** Lyric Opera of Chicago, LA Opera, San Francisco Opera, Glyndebourne. Add a house only if its premieres draw 3+ scored reviews (check Operawire, Bachtrack, Opera Today, Seen and Heard, local press first). SFO and ENO venue labels already exist.
