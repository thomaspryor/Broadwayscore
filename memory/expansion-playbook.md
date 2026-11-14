# Expansion playbook (CLAUDE.md §9)

1. Aggregators first, web search second. Scrape the market's aggregators before outlet-by-outlet search.
2. List first: build the season/production list from the best listing source, then recover reviews outlet by outlet, source opening dates from venue/listing pages (never URLs), and gate publication on a completeness check against a pooled source.
3. Start with the current season; backfill only after the completeness gate holds.
4. Regional markets: one hub per country, city chips from a shared registry, `market: regional` + `country`. US feeder table and UK `data/uk-regional-venues.json` are the two registry halves.

UK regional hubs (markets, competitors, cost, current-year vs backfill): `docs/bro-6500-uk-regional-hubs.md`.
Regional add runbook and US watchlist: `project_regional_expansion_watchlist.md`.
