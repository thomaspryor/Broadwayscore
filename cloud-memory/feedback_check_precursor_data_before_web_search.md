---
name: check-precursor-data-before-web-search
description: "For awards/precursor questions, grep data/precursors/*.json BEFORE any WebSearch — we have all precursor data scraped already"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a8f3099f-131a-4902-a609-4ec84ae1033e
---

For any question about who won/was-nominated at Drama Desk, Outer Critics Circle, Drama League, NYDCC, Pulitzer, Obie, Lortel, OBA, Critics' Circle, Evening Standard, or WhatsOnStage — query `data/precursors/{ceremony}.json` first. It's already scraped, complete, and authoritative.

**Why:** Discovered 2026-05-24 fixing Cats: The Jellicle Ball OB-precursor credit. I ran 4 web searches to disambiguate whether Cats won 2025 Drama Desk Direction/Choreography (sources contradicted each other) before the user pointed out we already had `data/precursors/drama-desk.json` — which answered the question in one query. The web searches were wasted effort AND introduced source-conflict ambiguity that the canonical scrape doesn't have.

**How to apply:** Before launching WebSearch for award winners/noms/categories, run:
```
node -e "const d=require('./data/precursors/{ceremony}.json').data; console.log(JSON.stringify(d['{Category}'].find(r=>r.year===YEAR)))"
```
Available ceremonies: `drama-desk`, `outer-critics`, `drama-league`, `nydcc`, `pulitzer`, `pulitzer-historic`, `obie`, `lortel`, `oba`, `critics-circle`, `evening-standard`, `whatsonstage`.

**Caveats:**
- `data/precursors/obie.json` has `note: 'Notable winners only (no nominees) — Wikipedia does not have per-category Obie Award pages.'` Coverage stops at 2019. For 2020+ Obies, web search is the only path — but the user notes Obies aren't a reliable signal these days (don't open backfill cards).
- The scraper has known row-parser bugs in OCC for performer-name winners (rows where `winner` ends with `,` and the show was dropped from `nominees`). Audit pattern: `grep -nE '"winner": "[^"]+,"' data/precursors/outer-critics.json`. See [[occ-scraper-trailing-comma-bug]] (Notion 36a637c5-416f-81eb-9bd9-e0488cc53f47).
- Routing from precursor → awards.json runs through `scripts/enrich-awards-with-precursors.js`. If the precursor JSON is well-formed but the matching is broken (e.g., OB→Broadway transfer season mismatch), look at `applyDDOCCDL` / `findShowIdByTitle` / `lookupWinnerShowIds`.

Related: [[awards-json-dual-repo]] — awards.json lives in both web and private data repos; CI overlays the private copy.
