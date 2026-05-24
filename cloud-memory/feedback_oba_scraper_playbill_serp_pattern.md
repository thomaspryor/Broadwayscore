---
name: oba-scraper-playbill-serp-pattern
description: One-shot SERP-discovery scraper pattern for awards without Wikipedia coverage — Playbill round-up articles via SERP + DOM-structure parsing
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1dc4c18c-8175-4bfd-a25d-0508d20c44fc
---

For awards with no Wikipedia page (e.g. Off Broadway Alliance Awards),
the working scraper pattern is:

1. **SERP-discover** the Playbill annual round-up article via
   `serpQuery('site:playbill.com "<Award Name>" winners YYYY', {preferSpeed:true})`
   from `scripts/lib/url-discovery.js`. Filter to `playbill.com/article/`
   URLs containing the award slug + winner-ish keyword. Don't gate on
   year-in-slug — Playbill often uses "Nth Annual" only, and COVID-era
   ordinal math breaks year→ordinal mapping.

2. **Trust the article, not the query.** Extract real ceremony year from
   JSON-LD `datePublished` BEFORE stripping `<script>` tags. SERP for year
   Y will routinely return year Y±1 articles; canonical-year extraction +
   `seenCeremonyYears` dedupe handles this cleanly.

3. **Parse DOM structure, not flattened text.** Playbill formats each
   category as a `<p>` with the header in `<strong>` or `<b>`, nominees
   separated by `<br>`, show titles wrapped in `<em>` (modern) or `<i>`
   (legacy pre-2020). Winners marked with `WINNER -` (modern) or leading
   `*` (legacy). Splitting on `<br>` then extracting per-segment `<em>/<i>`
   content is reliable across 15 years of format drift.

4. **Use `applyDDOCCDL` not `applyObie`** in `enrich-awards-with-precursors.js`.
   `applyObie` is winner-only and doesn't thread `obShowsBySeason` —
   Off-Broadway shows route through Pass 5 which `applyDDOCCDL` handles.
   Winner-only awards still work via `applyDDOCCDL` when nominees just
   includes the winner alone.

**Why:** Initial premise was "mirror scrape-obie.js (Wikipedia → JSON)" —
fails for OBAA (no Wikipedia). Second-opinion review caught that
`applyObie` would silently 0% match OB shows because of missing Pass 5
routing, and that the "WINNER -" prefix scan against flattened textContent
loses `<br>` boundaries and runs adjacent titles together.

**How to apply:** When asked to add a new precursor award:
- First verify Wikipedia coverage with `curl -s "https://en.wikipedia.org/w/api.php?action=opensearch&search=AWARD_NAME&format=json"`
- If 404/empty, switch to Playbill SERP pattern (don't waste time hand-curating)
- Use `scripts/scrape-off-broadway-alliance.js` as the reference template
- Run scoring delta proxy: call `computeSiteAwardScore(showId)` directly
  on 3-5 known winners and verify ceremony contribution appears with
  expected tier points (see `/tmp/oba-score-test.mjs` pattern).

Related: [[scoring-delta-required]] is for review-scoring (`engine.ts`,
`review-guards.js`), NOT awards-scoring (`awards-scoring.ts`). Don't
conflate — the watchlist in CLAUDE.md rule 12.7 is specific.
