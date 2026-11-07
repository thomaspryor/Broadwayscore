# BRO-6500: UK regional theatre hubs. Markets, competitors, plan, cost, time

Research and recommendation only (owner request 2026-10-29). No build, no spend beyond research.
Companion: BRO-6498 (US city hubs). Section 5 proposes the shared market model for both.

**Evidence labels.** MEASURED = computed from this repo's data today. EXTERNAL = from a cited web page. ESTIMATE = my judgment, not measured; verify in the Phase 0 census before committing spend.

## 1. Bottom line

1. Ship ONE "UK Regional" hub (not one hub per city), with city/venue filter chips, current season only, centred on the tryout-to-West-End pipeline we already auto-ingest from the Guardian trigger.
2. Launch with 11 flagship houses (already in `data/uk-regional-venues.json`) plus Edinburgh (festival-season only). Defer Fringe, Cardiff, Belfast, and touring as separate phases.
3. Do NOT backfill at launch. Backfill only transfers (regional runs that later reached the West End or Broadway), after the completeness gate passes on the current season.
4. First step is a UK-scope outlet census (about 1 week). The BRO-6488 census cannot answer this question today (see 2.2).

## 2. What we actually have (MEASURED)

### 2.1 Corpus
- `shows.json`: 47 `regional` shows, all US except one UK: `game-of-thrones-the-mad-king-regional-2026` (Royal Shakespeare Theatre, opened 2026-08-08). 69 `tour` shows, all North American. Zero UK-regional or UK-tour shows exist as of 2026-10-29.
- West End corpus: 850 `west-end` + 506 `off-west-end` shows; 13,360 reviews on `west-end` shows. UK outlet depth there: Guardian 674, WhatsOnStage 631, The Stage 604, Time Out 601, Standard 579, Telegraph 573, Times 525, London Box Office 494, FT 389, Reviews Hub 372, Independent 337, Observer 279, plus long tail of ~25 blogs. This is the outlet base a UK regional hub would reuse; the T1/T2 UK outlets already have registry entries and scrapers.
- Regional-outlet footprint in `reviews.json` (by URL domain): thereviewshub.com 226 (the UK critic collective with the widest regional reach), bachtrack 18, scotsman 3, heraldscotland 1, chroniclelive 2. BroadwayWorld rows (857) include its UK Regional section.
- Transfer signal: in West End review URLs/pull quotes, regional-origin mentions are Stratford 56, Edinburgh 25, Chichester 15, Manchester 10, Sheffield 9, Leeds 6, Bristol 5, Birmingham 5, Liverpool 8. These are rough (substring match, includes London mentions of the cities) but rank the feeder houses: RSC, Edinburgh, Chichester lead.
- Existing automation: `data/uk-regional-venues.json` lists 11 flagship houses (RSC, Chichester, Royal Exchange, Crucible, Leeds Playhouse, Bristol Old Vic, Birmingham Rep, Nottingham Playhouse, Liverpool Everyman, Royal Lyceum, Citizens). A Guardian review of a production at one of them auto-adds the show (BRO-4923, `tests/unit/uk-regional-guardian-trigger.test.mjs`). So the trigger exists; what is missing is review completeness per show and a UK-facing hub.

### 2.2 What the BRO-6488 / BRO-6481 census does NOT tell us
`data/audit/outlet-census/*.report.json` (52 outlets) is NYC-scoped: it matches outlet listings to NYC shows. For UK, `guardian`, `thestage`, `timeout`, `telegraph`-class outlets either are not in the census or are `unreadable` (Guardian: HTTP 403 to the census client; The Stage: unreadable). Result: no measured UK regional recall or volume exists. The issue text assumed the census captures regional reviews by venue; it does not for UK. A UK-scope census is Phase 0.

### 2.3 Not measurable from this machine
No local Theatre Record credentials, no ScrapingDog/ScrapingBee/Bright Data keys in this session, and `data/aggregator-archive` is not present in the worktree. So per-market review counts below are ESTIMATES built from the corpus signals plus external figures, not from a Theatre Record pull.

## 3. Markets (ranked) and expected volume

Volume per year = productions that get at least 3 professional reviews (our scoring floor), and average reviews each. ESTIMATE unless stated.

| Rank | Market | Houses | Productions/yr (3+ reviews) | Avg reviews | Reviews/yr | T1/T2 presence | Why |
|---|---|---|---|---|---|---|---|
| 1 | Stratford-upon-Avon | RSC (Royal Shakespeare, Swan) | 6-8 | 8-12 | 50-90 | Guardian, Telegraph, Times, Stage, Standard, FT all attend | Highest transfer rate to West End; 56 mentions in WE reviews |
| 2 | Edinburgh (non-Fringe) | Royal Lyceum, Traverse, King's, Festival Theatre; plus August International Festival | 8-12 | 5-8 | 50-90 | Guardian, Scotsman, Herald, Times, Telegraph at Festival | 25 WE mentions; Scottish press adds T2 |
| 3 | Chichester | Festival Theatre, Minerva | 6-8 | 8-12 | 50-90 | Full national press (summer season) | 15 WE mentions; big musical transfers |
| 4 | Manchester | Royal Exchange, HOME, Opera House | 6-10 | 4-6 | 30-60 | Guardian, Times, Stage | Strongest northern press scene (MEN, Reviews Hub) |
| 5 | Sheffield | Crucible, Lyceum, Studio | 5-8 | 4-6 | 20-45 | Guardian, Stage, Times | Crucible musicals transfer; Everything Theatre covers it |
| 6 | Leeds / Yorkshire | Leeds Playhouse, West Yorkshire Playhouse, York Theatre Royal | 5-8 | 3-5 | 15-40 | Guardian, Stage, Yorkshire Post | 6 WE mentions |
| 7 | Bristol / Bath | Old Vic, Tobacco Factory, Theatre Royal Bath | 4-7 | 3-5 | 12-35 | Guardian, Stage | Old Vic is a recurring feeder |
| 8 | Birmingham | Rep, Hippodrome | 4-6 | 3-5 | 12-30 | Guardian, Stage, Times | Birmingham Rep tours into hub markets |
| 9 | Liverpool | Everyman, Playhouse, Unity | 3-5 | 3-4 | 9-20 | Guardian, Stage | Thinner T1 coverage |
| 10 | Nottingham | Playhouse | 2-4 | 3-4 | 6-16 | Stage, Guardian occasionally | Thin |
| 11 | Glasgow | Citizens, Tron, Pitlochry, NTS | 3-6 | 3-5 | 9-30 | Herald, Guardian | Scottish T2 |
| 12 | Cardiff / Wales | Wales Millennium Centre, Sherman | 3-5 | 3-4 | 9-20 | Wales Arts Review, Guardian | Thin T1 |
| 13 | Belfast | Lyric, Grand Opera House | 2-4 | 3-4 | 6-16 | Irish Times, Belfast Telegraph | Cross-border outlet set |
| - | Edinburgh Fringe | 299 venues, about 4,200 shows (2026, EXTERNAL) | 40-80 with 3+ reviews | 4-6 | 200-400 | Guardian, Scotsman, Times, Telegraph, Herald; star-scale outlets | Different review economy (many stars, short runs); separate phase |
| - | UK touring | Dozens of producing houses | n/a | 1-3 | scattered | Mostly BWW UK, local press | Poor review density per production; skip |

Totals (ESTIMATE): ranks 1-11, about 55-85 productions and 280-540 reviews per year; adding Fringe, about 100-160 productions and 500-900 reviews. External corroboration of the order of magnitude: Theatre Record reported 46 productions reviewed in April 2025 across regions, Scotland, and London combined, and 24 in its August 2024 main issue (EXTERNAL, theatrerecord.com/news). Regional is a minority of that, consistent with 5-10 per month.

Measurable cutoff for "substantial": we propose the hub includes a production only at 3+ professional reviews, and a market only if it yields 5+ such productions a year with at least one T1/T2 outlet attending. By that rule ranks 1-8 qualify clearly; 9-13 qualify as "listed, thin" and ship in the same hub without their own filter chip until a season shows 5+.

## 4. How others define UK markets (EXTERNAL unless noted)

| Site | UK market model | Reviews? | Note for us |
|---|---|---|---|
| WhatsOnStage | London vs "UK" with region filter: England sub-regions (North West, West Midlands etc.), Scotland (Central, Glasgow and Clyde Valley), Wales, Northern Ireland; tours treated as UK-wide | Yes, critic reviews, and a (stale, June 2019) best-reviewed-outside-London roundup | Closest competitor; region taxonomy usable as our tag |
| BroadwayWorld UK Regional | `/uk-regional/` section: reviews of tours and regional houses (e.g. The Bodyguard tour Apr 2026, Watermill Victoria) | Yes, own critics, volume heavy | Already in our ingest (857 BWW rows) |
| Everything Theatre | "Regional" category, "reviews from outside London and Edinburgh"; Sheffield-heavy | Yes, blog-tier | T4 source |
| British Theatre Guide | Regions as Yorkshire and North East, North West, etc. | Yes | Regional-first, long tail |
| Theatre Record | Listings by West End, rest of London, Scotland, regional England and Wales; 54-56k productions in archive; monthly issue with critic reviews pooled (171 venues covered in Aug 2025) | Review aggregator in print and online (paid) | Best single source for regional completeness; we have an extractor (`scripts/extract-theatre-record.js`, `--browse-we`, `--browse-london`), no regional mode yet |
| The Stage | Reviews by region, regional editorial | Yes, T2 | Census source (unreadable today) |
| Guardian | Stage reviews are national, venue-tagged; heavy on RSC, Chichester, northern houses | Yes, T1 | Existing BRO-4923 trigger |
| TodayTix, ATG/Trafalgar, LW Theatres, SOLT/Official London Theatre, UK Theatre, Show Score, theatre.reviews, London Box Office | Ticketing and trade bodies: London-centric (SOLT, LW, Official London Theatre are West End only by definition); TodayTix and ATG list by city for ticket sales; theatre.reviews and London Box Office are London-focused | No critic aggregation outside London; not verified in detail in this pass | Not competitors for scored regional reviews; useful only for dates and ticket links. Not checked page-by-page: TodayTix city list and ATG venue list (search returned nothing); verify in Phase 0 |

Competitive gap: nobody publishes a scored, cross-outlet aggregate for UK regional productions. WhatsOnStage's roundup is stale since 2019 and BWW UK is a single-source review stream. That supports a UK Regional hub, but the audience for it is smaller than the West End's, so keep costs low.

## 5. Shared market model with BRO-6498 (US city hubs)

Proposal so both hubs use one model and one infrastructure:

- `market`: `regional` stays the show-level market for both US and UK regional shows, with a new `country` field (`US`/`UK`). Do not add a new market value per city (avoids touching every `market === ` switch).
- `hub`: a single registry file, one row per city/venue cluster: `{hubId, country, city, venues[], domains[], tier}`. `data/uk-regional-venues.json` becomes the UK half; the US feeder table `REGIONAL_FEEDER_VENUES` (`scripts/lib/aggregator-candidate-extract.js`) becomes the US half. Both read through one loader.
- Product shape: one "Regional" hub per country (`/uk-regional`, plus the existing pre-Broadway page for the US), city chips filter within it. City-specific pages only when a city passes 5+ productions a year with 3+ reviews, and then they are generated from the same registry, not hand-built.
- Score label: regional shows use the existing regional treatment (tryout score shown with the threshold-gated transfer link, `transferOf`/`transferredTo`).
- Gap to resolve with BRO-6498: I could not read that session's output (issue is In Progress, no document posted yet). Chicago, DC, and LA are in its scope; this model should hold for them, but I have not confirmed they agree.

## 6. Data sources and mechanics

1. Discovery (list first, as in the West End backfill): Theatre Record regional listings (new `--browse-regional` mode, mirror of `--browse-we`), plus the 11-house Guardian trigger already live, plus venue season pages from `uk-regional-venues.json` domains.
2. Reviews, outlet by outlet: Guardian, Times, Telegraph, The Stage, WhatsOnStage, Standard (when it reviews), Scotsman/Herald (Scotland), Reviews Hub, Everything Theatre, BWW UK. Reuse existing outlet scrapers; add Scotsman, Herald, Yorkshire Post, MEN only if the census shows 10+ regional reviews a year each.
3. Opening dates: from venue pages and Theatre Record; never from URLs (CLAUDE.md rule 3). Validate with `scripts/validate-show-venue.js` before adding stubs.
4. Completeness check: diff per production against Theatre Record's pooled critic list, mirroring the WE completeness gate (`project_we_completeness_gate`). Do not publish a production below 3 reviews.
5. Scoring: existing ensemble LLM scoring and star-band caps; UK outlets already have star scales in the registry.
6. Fringe, if done: outlet-by-outlet census restricted to August; Fringe star ratings are inflated, so re-calibrate (A/B check per CLAUDE.md rule 13) before it counts in the composite.

## 7. Current year vs backfill

Recommendation: current season only (September 2025 to now), then transfers-only backfill; no full backfill.

Reasons, from the West End backfill learnings (BRO-5843, BRO-5851, BRO-6268, BRO-6419, BRO-6450, BRO-6480, BRO-6481/6488; I read the repo traces, not every Linear thread):
- List-first season building worked; for regional there is no equivalent single list, so the first deliverable is a trustworthy season list (Theatre Record + venue pages). Without it a backfill inherits the West End's recall problem with no way to measure it.
- Outlet recovery is the expensive part: older UK URLs are paywalled or moved (Times, Telegraph, Stage). Recovery cost per review rises with age.
- Opening-date sourcing for regional is weaker than for the West End (no single Playbill-like source), so each old production needs manual dating.
- Audience value: regional scores matter mainly as a tryout signal for productions that later transfer. That is the transfers-only backfill: for each West End/Broadway show with a UK regional origin, attach the original run (`transferOf`). Candidate set is small (dozens).

Gate to widen: current season completeness at 85%+ of Theatre Record's listed reviews for 3 consecutive months, then backfill the prior season only if hub traffic justifies it (check the PostHog Real Users lens).

## 8. Plan, time, cost (ESTIMATES; no spend incurred)

| Phase | Work | Calendar time | Worker sessions | Direct cost |
|---|---|---|---|---|
| 0 | UK-scope census: add UK outlets (Guardian via Browserbase/SERP since 403, Stage, Telegraph, Times, Scotsman, Herald, Reviews Hub, WhatsOnStage) to census sources, run for 2025-26, produce per-house counts. Confirms or corrects section 3 | 5-7 days | 2-3 | about 50-100k scraping credits |
| 1 | Hub registry + country field; `--browse-regional` for Theatre Record; extend Guardian trigger to ranks 1-11; shows auto-add with validate-show-venue | 7-10 days | 4-5 | negligible |
| 2 | Current-season ingest: about 60-80 productions, 300-500 reviews; ensemble score; completeness gate | 7-10 days | 3-4 | scraping: 150-300k credits; LLM: 400 reviews x about 6k tokens x 3-model ensemble is about 7M input tokens, roughly $25-80 depending on model mix |
| 3 | UK Regional hub UI from shared components, flag-gated, visual QA | 5-7 days | 2-3 | none |
| 4 | Transfers-only backfill (dozens of shows) | 5 days | 2 | about 50k credits, about $10 LLM |
| Later | Fringe season (August) | 1 season | 3-4 | 100-200k credits, $50-100 LLM |

Totals through Phase 3: about 4-5 calendar weeks if sessions run in parallel, 11-15 worker sessions, scraping roughly 250-450k credits (current ScrapingDog plan had 2.4M credits left per `docs/credits-scrapingdog-usage.md`, so it fits without a plan change; the breaker ceiling must be raised or reserved), LLM roughly $30-100. Theatre Record needs the paid subscription active (`reference_paywall_subscriptions_status` says paywall subs were cancelled in July 2026 and TR is the paid UK archive); confirm with the owner before Phase 1. That is the one hard dependency.

## 9. Risks
- Theatre Record login required; subscription state unknown to this session.
- Guardian and The Stage return 403 to the census client; need Browserbase/SERP path, which costs more per page.
- Estimates in section 3 are unmeasured; Phase 0 exists to replace them. If Phase 0 shows under 40 qualifying productions a year, shrink to ranks 1-5 and fold the rest into "Regional (other)".
- Market-model change touches switches on `market`; mitigated by using a `country` field rather than a new market value.

## 10. Decisions for the owner
1. Approve Phase 0 census (about 5 days, up to 100k credits).
2. Confirm Theatre Record subscription can be reactivated for Phase 1.
Default if no answer: run Phase 0 only; nothing after it starts.
