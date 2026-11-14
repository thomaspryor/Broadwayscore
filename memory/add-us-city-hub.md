# Add a US city hub (runbook, BRO-6833)

A city hub is `/tours/<slug>` plus a menu entry, footer link/card, stats and an app market.
Everything the website renders is driven by ONE registry entry. `tests/unit/city-hub-wiring.test.ts` fails if a piece is missing.

## Steps
1. **Registry entry** in `data/city-hubs.json` (`hubs.<slug>`), slug = `<city>-<st>` (the value stored in `show.city`). Start with `launched: false` (required, explicit boolean; only `true` is live). Fields: name/short/home, optional `since`, emoji/cardLabel/menuSub, `appMarket`, `discoverySource`, and a `tic` block (key, base, host, files, since). `src/lib/city-hub.ts` reads it; `HUB_CITIES` is the launched subset.
2. **Venue metro**: `data/venue-metros.json` (core-data repo): `hubs[venueHub]`, `metros[slug]` with that hub, and every suburb in `places` (place string -> slug). Exclude neighbouring metros (DC gotcha: Baltimore, Columbia, Annapolis, Frederick are NOT DC).
3. **Discovery source** (`LOCAL_DISCOVERY_SOURCES` in BOTH `src/lib/local-market.ts` and `scripts/lib/local-market.js`; `local-market.test.ts` pins parity). Only for sites that feed local-only shows.
4. **Theatre Limelight cities** (theatreinchicago/indc/inla.com): the `tic` block in the registry feeds `scripts/lib/tic-cities.js`; add tourHouses, venueCities, requireMetro, minOutlets there.
5. **Dry run** (no writes, ~1 credit per fetch, ~25-50 credits): `node scripts/tic-daily.js --city=<key> --dry-run --max=40`. It prints `STAGED id | title | venue | dates | review links` and skip reasons. Review the list by eye (wrong venues, tours, wrong production).
6. **Workflow steps** (only at launch): add a `tic-daily.js --city=<key>` step to `.github/workflows/scrape-new-aggregators.yml` (copy the DC step, advisory first, CLAUDE.md section 19), run `/second-opinion` before editing workflows (section 18).
7. **Launch** (owner decision; costs money): flip `launched: true`. Menu, footer, sitemap, static params and `getMarketStats().hubs` follow automatically. Seed with a first real pickup run, then score (see Costs).
8. **App** (`BroadwayScorecard-app`, `lib/market-filter.ts`): add the city to `CITY_MARKETS` (slug must equal the registry slug; the feed field `cy` carries it), extend `tests/unit/city-market.test.mjs`'s web-hub list, ship one OTA via `eas-build.yml` on main (no force_build; the job log must say OTA).
9. **Verify**: `npx tsx --test tests/unit/city-hub-wiring.test.ts tests/unit/hub-menu-count.test.ts`; `/visual-qa` menu + footer at mobile and desktop; `node scripts/check-prod-deploy.js HEAD --wait`; open `/tours/<slug>`.

## Costs (DC actuals, 2026-11)
About $36 of Claude usage across 2 sessions plus about $10 of scoring/scraping. A new Limelight city with the registry in place should be well under that; most spend is review recovery and the review-coverage pass.

## Gotchas learned on Chicago and DC
- TIC critic names carry typos; map outlets through the registry, do not trust the raw name.
- First-review dates on Limelight pages are the production's first review, not opening night; check `openingDate` before trusting `since` filters.
- Baltimore/Columbia/Annapolis/Frederick appear on theatreindc but are other metros: keep `venueCities` explicit, never a state-wide match.
- Every `venueCities` entry needs a `places` line in venue-metros.json (e.g. LA's Hollywood, Burbank); otherwise `requireMetro` silently drops those houses. The wiring test checks it.
- `scripts/send-opening-digest.js` still hand-wires `CITY_REGIONS` and `REGION_BRAND` per city: add the new slug there (the wiring test fails if missing).
- Images need `sm` variants or hub cards render blank; run the image promotion step (`last-promotion-ids.json`).
- Menu "playing now" = local productions + tour stops playing today (`hubMarketStats`); `tests/unit/hub-menu-count.test.ts` pins it to the hub page.
- Run a review-coverage pass for productions with TBD/zero reviews before launch.
- LLM scoring raises false wrong-production flags on remounts of the same title; spot-check flagged reviews.
- A tsx test that loads data modules must set `process.env.NEXT_PUBLIC_FEATURES = 'regional,tour'` BEFORE the dynamic import: land CI runs with no flags.
- Local rows must stay out of Broadway/West End browse, search and related shows (`isLocalOnlyShow`).
- Staged cities (`launched:false`) are filtered out of `HUB_CITIES`; never read `ALL_HUB_CITIES` in a page, menu or sitemap.

## Los Angeles (staged, NOT launched)
Registry `los-angeles-ca`, tic key `la`. Dry run 2026-11-02 (`--max=40`): 9 listed, 6 would be added: The Best Medicine (Odyssey), The Feel Good Story America Needs Right Now (Theatre West, West Hollywood), Heartbreak House (Antaeus, Glendale), Kaiju (The Road on Magnolia, North Hollywood), Rorschach (Skylight), Saint Megan (The Matrix). Skipped: 2 tour houses, 1 duplicate. (An earlier run showed 4 because Hollywood/Burbank places were missing from venue-metros.json.) Launch is an owner decision.
