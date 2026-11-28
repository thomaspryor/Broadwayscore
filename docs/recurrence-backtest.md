# Recurrence detector backtest (BRO-7103)

Generated 2026-11-11 over the last 60 days (7049 cards), replayed one day at a time with the 30-day window. A class is flagged at 3+ cards in the window, or when one of its alerts came back after being resolved.

Flagged: 78 classes. Likely false positives: 12 (shown with a note; the live detector does not file these). Expected repeats excluded: 8.

## Hit list

| Class | First flagged | Cards | Filed after flag | Root card | Note |
|---|---|---|---|---|---|
| review gap missing cited | 2026-09-22 | 90 | 69 | BRO-7116 |  |
| unit tests run | 2026-09-21 | 81 | 74 | BRO-3425 |  |
| watchdog parked redispatch produced launch | 2026-09-18 | 31 | 0 |  | every card was canceled or a duplicate |
| roundup listed review captured | 2026-09-30 | 26 | 22 | BRO-7203 |  |
| unit tests run scripts lib | 2026-10-18 | 18 | 15 | BRO-3425 |  |
| national tour pages show wrong information page problem | 2026-10-09 | 14 | 11 | BRO-7118 |  |
| e2e tests run unit | 2026-09-21 | 13 | 10 | BRO-3425 |  |
| bright data daily breaker tripped web unlocker2 | 2026-10-19 | 12 | 6 | BRO-7202 |  |
| opening night poller failed | 2026-10-20 | 12 | 9 | BRO-7117 |  |
| e2e tests run | 2026-10-09 | 11 | 8 | BRO-3425 |  |
| reddit post ready | 2026-10-04 | 10 | 6 |  |  |
| review gap audit refused write shows changed coverage | 2026-09-14 | 9 | 6 |  |  |
| stuck pipeline items | 2026-10-16 | 9 | 5 | BRO-7276 |  |
| main test yml red auto dispatch did resolve | 2026-10-23 | 9 | 5 | BRO-3425 |  |
| watchdog parked linear bro redispatch produced launch | 2026-09-18 | 8 | 0 |  | every card was canceled or a duplicate |
| slug mismatch lifetime sweep | 2026-10-17 | 8 | 4 | BRO-7204 |  |
| show need review | 2026-11-02 | 7 | 2 | BRO-7275 |  |
| opening night checklist | 2026-09-13 | 6 | 1 |  |  |
| morning digest did arrive | 2026-09-29 | 6 | 1 |  | every card was canceled or a duplicate |
| missed-at-first-pass:west-end:all-that-dazzles-uk | 2026-09-30 | 6 | 3 |  |  |
| missed-at-first-pass:off-broadway:theatermania | 2026-10-05 | 6 | 3 |  |  |
| lint workflows audit submitter pii committed data files | 2026-10-19 | 6 | 3 | BRO-3425 |  |
| weekly video reviews | 2026-09-18 | 5 | 2 |  |  |
| quality dmarc deliverability | 2026-09-23 | 5 | 2 |  |  |
| missed-at-first-pass:west-end:guardian | 2026-09-30 | 5 | 2 |  |  |
| missed-at-first-pass:west-end:thestage | 2026-10-01 | 5 | 2 |  |  |
| missed-at-first-pass:off-broadway:vulture | 2026-10-05 | 5 | 2 |  |  |
| shows missing poster synopsis tickets | 2026-10-05 | 5 | 2 |  |  |
| missed-at-first-pass:west-end:whatsonstage | 2026-10-08 | 5 | 1 |  |  |
| quality corpus drift | 2026-10-13 | 5 | 0 |  |  |
| headless dispatch success rate | 2026-10-26 | 5 | 1 |  |  |
| revival unverified lifetime sweep | 2026-10-31 | 5 | 1 | BRO-7354 |  |
| stale announced shows | 2026-11-02 | 5 | 1 | BRO-7277 |  |
| cross outlet attribution drift | 2026-11-06 | 5 | 0 |  |  |
| fetch guardian reviews via api | 2026-09-13 | 4 | 1 |  |  |
| audit aggregator review gap | 2026-09-13 | 4 | 1 |  |  |
| process feedback submissions | 2026-09-13 | 4 | 0 |  |  |
| tests unit session start disk check test mjs | 2026-09-13 | 4 | 0 |  | all cards filed within 24 hours (one incident, not a repeat) |
| after helen troy | 2026-09-16 | 4 | 0 |  | all cards filed within 24 hours (one incident, not a repeat) |
| ledger explains only billed | 2026-09-30 | 4 | 1 |  |  |
| missed-at-first-pass:off-broadway:nysr | 2026-10-05 | 4 | 1 |  |  |
| missed-at-first-pass:off-broadway:culturesauce | 2026-10-05 | 4 | 0 |  |  |
| missed-at-first-pass:west-end:broadwayworld | 2026-10-08 | 4 | 1 |  |  |
| unit tests ordinal publishdate guard parity | 2026-10-12 | 4 | 0 | BRO-3425 |  |
| opening digest did arrive | 2026-10-25 | 4 | 0 |  |  |
| scripts lib tests red | 2026-10-29 | 4 | 0 |  |  |
| wrongproduction lifetime sweep | 2026-10-29 | 4 | 0 |  |  |
| commercial model drift | 2026-11-01 | 4 | 0 |  |  |
| text-missed-at-first-pass:off-broadway:nytimes | 2026-11-06 | 4 | 1 |  |  |
| update lottery rush | 2026-11-10 | 4 | 0 | BRO-7332 |  |
| rebuild reviews data | 2026-09-13 | 3 | 0 |  |  |
| scripts lib bww archive category guard test mjs | 2026-09-13 | 3 | 0 |  | all cards filed within 24 hours (one incident, not a repeat) |
| commercial rss poll | 2026-09-13 | 3 | 0 |  |  |
| west end historical scoring backfill | 2026-09-13 | 3 | 0 |  | every card was canceled or a duplicate |
| extend batch discount pattern enrich reviews yml classify | 2026-09-13 | 3 | 0 |  | every card was canceled or a duplicate |
| christmas carol recoverable reviews | 2026-09-13 | 3 | 0 |  | every card was canceled or a duplicate |
| integrate contamination audit into rebuild pre pass | 2026-09-13 | 3 | 0 |  | every card was canceled or a duplicate |
| new flag contradictions | 2026-09-16 | 3 | 0 |  |  |
| rage clicks best value page | 2026-09-17 | 3 | 0 |  | every card was canceled or a duplicate |
| missed-at-first-pass:off-broadway:blogcritics | 2026-09-23 | 3 | 0 |  |  |
| record carrying live duplicateof pointer stale duplicateofcleared breadcrumb | 2026-10-17 | 3 | 0 |  |  |
| older than 24h | 2026-10-18 | 3 | 0 |  |  |
| exclusion flag contradicted own content verification pass | 2026-10-18 | 3 | 0 |  |  |
| e2e tests setup playwright | 2026-10-23 | 3 | 0 | BRO-3425 |  |
| tests unit opening night orchestrator cron test mjs | 2026-10-27 | 3 | 0 |  | all cards filed within 24 hours (one incident, not a repeat) |
| same title sibling review misrouted wrong production | 2026-11-01 | 3 | 0 |  |  |
| llm scoring daily spend over budget | 2026-11-01 | 3 | 0 |  |  |
| missed-at-first-pass:off-broadway:front-row-center | 2026-11-05 | 3 | 0 |  |  |
| off broadway venue complex unlinked bare form keyword | 2026-11-05 | 3 | 0 |  |  |
| review missing pullquote recoverable excerpt sitting unused texts | 2026-11-05 | 3 | 0 |  |  |
| bro repo actions cache stays below size evicts | 2026-11-05 | 3 | 0 |  |  |
| review files wrongproduction provenance but flag dropped | 2026-11-05 | 3 | 0 |  |  |
| missed-at-first-pass:off-west-end:everything-theatre | 2026-11-06 | 3 | 0 |  |  |
| real data byte identical art across unrelated unlinked | 2026-11-07 | 3 | 0 |  |  |
| early publish dates awaiting page date recheck | 2026-11-08 | 3 | 0 | BRO-7355 |  |
| codex runner landing cards | 2026-11-08 | 3 | 0 | BRO-7356 |  |
| armed but vacuous backlog cards | 2026-11-09 | 3 | 0 | BRO-7333 |  |
| unit test shard run scripts lib tests | 2026-11-11 | 3 | 0 | BRO-3425 |  |

Cards filed after the first flag (285 in all) are the ones a root-cause fix on the flag date could have prevented.

## First-pass misses under the bar (BRO-7375)

152 outlet classes had a first-pass miss but on fewer than 3 shows in any 30-day window, so nothing was filed:

- missed-at-first-pass:off-west-end:london-theatre (4 shows)
- missed-at-first-pass:off-west-end:whatsonstage (4 shows)
- missed-at-first-pass:off-broadway:lighting-and-sound-america (3 shows)
- missed-at-first-pass:off-broadway:new-york-notebook (3 shows)
- missed-at-first-pass:off-broadway:nytg (3 shows)
- missed-at-first-pass:off-broadway:off-off-online (3 shows)
- missed-at-first-pass:off-broadway:theatrely (3 shows)
- missed-at-first-pass:off-west-end:broadwayworld (3 shows)
- missed-at-first-pass:off-west-end:london-box-office (3 shows)
- missed-at-first-pass:off-west-end:londontheatre1 (3 shows)
- missed-at-first-pass:off-west-end:musical-theatre-review (3 shows)
- missed-at-first-pass:off-west-end:theatre-weekly (3 shows)
- missed-at-first-pass:west-end:artsdesk (3 shows)
- missed-at-first-pass:west-end:timeout-london (3 shows)
- missed-at-first-pass:broadway:talkinbroadway (2 shows)
- missed-at-first-pass:off-broadway:new-york-sun (2 shows)
- missed-at-first-pass:off-broadway:nyt-theater (2 shows)
- missed-at-first-pass:off-broadway:nytimes (2 shows)
- missed-at-first-pass:off-broadway:one-minute-critic (2 shows)
- missed-at-first-pass:off-broadway:theater-pizzazz (2 shows)
- missed-at-first-pass:off-broadway:theater-scene (2 shows)
- missed-at-first-pass:off-broadway:this-week-in-new-york (2 shows)
- missed-at-first-pass:off-broadway:timeout (2 shows)
- missed-at-first-pass:off-west-end:british-theatre (2 shows)
- missed-at-first-pass:off-west-end:firstnightmagazine (2 shows)
- missed-at-first-pass:off-west-end:guardian (2 shows)
- missed-at-first-pass:off-west-end:readaboutstuff (2 shows)
- missed-at-first-pass:off-west-end:standard (2 shows)
- missed-at-first-pass:off-west-end:the-recs (2 shows)
- missed-at-first-pass:off-west-end:the-spy-in-the-stalls (2 shows)
- missed-at-first-pass:off-west-end:thereviewshub (2 shows)
- missed-at-first-pass:off-west-end:west-end-best-friend (2 shows)
- missed-at-first-pass:west-end:bestoftheatre (2 shows)
- missed-at-first-pass:west-end:financialtimes (2 shows)
- missed-at-first-pass:west-end:independent (2 shows)
- missed-at-first-pass:west-end:london-theatre (2 shows)
- missed-at-first-pass:west-end:londontheatre1 (2 shows)
- missed-at-first-pass:west-end:standard (2 shows)
- missed-at-first-pass:west-end:telegraph (2 shows)
- missed-at-first-pass:west-end:theatre-weekly (2 shows)
- missed-at-first-pass:west-end:theatreandtonic (2 shows)
- missed-at-first-pass:west-end:thereviewshub (2 shows)
- missed-at-first-pass:west-end:times-uk (2 shows)
- text-missed-at-first-pass:off-broadway:nytg (2 shows)
- missed-at-first-pass:broadway:culturesauce (1 show)
- missed-at-first-pass:broadway:globalnews2 (1 show)
- missed-at-first-pass:broadway:harunaenterprisesltd (1 show)
- missed-at-first-pass:broadway:hoodline (1 show)
- missed-at-first-pass:broadway:jks-theatre-scene (1 show)
- missed-at-first-pass:broadway:new-york-sun (1 show)
- missed-at-first-pass:broadway:theatrely (1 show)
- missed-at-first-pass:broadway:times-square-chronicles (1 show)
- missed-at-first-pass:broadway:variety (1 show)
- missed-at-first-pass:off-broadway:adriandimanlig (1 show)
- missed-at-first-pass:off-broadway:airmail (1 show)
- missed-at-first-pass:off-broadway:av-club (1 show)
- missed-at-first-pass:off-broadway:beautynewsnycofficial (1 show)
- missed-at-first-pass:off-broadway:boothhistory (1 show)
- missed-at-first-pass:off-broadway:cititour (1 show)
- missed-at-first-pass:off-broadway:consequence (1 show)
- missed-at-first-pass:off-broadway:corrblimey (1 show)
- missed-at-first-pass:off-broadway:exeunt-magazine (1 show)
- missed-at-first-pass:off-broadway:guardian (1 show)
- missed-at-first-pass:off-broadway:musical-theatre-report (1 show)
- missed-at-first-pass:off-broadway:new-york-classical-review (1 show)
- missed-at-first-pass:off-broadway:newsbreak (1 show)
- missed-at-first-pass:off-broadway:newyorker (1 show)
- missed-at-first-pass:off-broadway:oxfordshire-guardian (1 show)
- missed-at-first-pass:off-broadway:pages-on-stages (1 show)
- missed-at-first-pass:off-broadway:seattle-times (1 show)
- missed-at-first-pass:off-broadway:stageandcinema (1 show)
- missed-at-first-pass:off-broadway:talkinbroadway (1 show)
- missed-at-first-pass:off-broadway:the-interested-bystander (1 show)
- missed-at-first-pass:off-broadway:the-recs (1 show)
- missed-at-first-pass:off-broadway:thestage (1 show)
- missed-at-first-pass:off-broadway:thewrap (1 show)
- missed-at-first-pass:off-broadway:third-coast-review (1 show)
- missed-at-first-pass:off-broadway:times-square-chronicles (1 show)
- missed-at-first-pass:off-broadway:times-uk (1 show)
- missed-at-first-pass:off-broadway:washington-square-news (1 show)
- missed-at-first-pass:off-broadway:woman-around-town (1 show)
- missed-at-first-pass:off-broadway:wsj (1 show)
- missed-at-first-pass:off-west-end:a-youngish-perspective (1 show)
- missed-at-first-pass:off-west-end:all-that-dazzles-uk (1 show)
- missed-at-first-pass:off-west-end:cherylmarkosky (1 show)
- missed-at-first-pass:off-west-end:cineramafilm (1 show)
- missed-at-first-pass:off-west-end:coffee-table-notes (1 show)
- missed-at-first-pass:off-west-end:creative-reviews-uk (1 show)
- missed-at-first-pass:off-west-end:financialtimes (1 show)
- missed-at-first-pass:off-west-end:gramilano (1 show)
- missed-at-first-pass:off-west-end:independent (1 show)
- missed-at-first-pass:off-west-end:jonathan-baz (1 show)
- missed-at-first-pass:off-west-end:london-theatre-reviews (1 show)
- missed-at-first-pass:off-west-end:loureviews (1 show)
- missed-at-first-pass:off-west-end:plays-to-see (1 show)
- missed-at-first-pass:off-west-end:radio-times (1 show)
- missed-at-first-pass:off-west-end:redbuslondinium (1 show)
- missed-at-first-pass:off-west-end:reviewsgate (1 show)
- missed-at-first-pass:off-west-end:seeing-dance (1 show)
- missed-at-first-pass:off-west-end:sierz-co-uk (1 show)
- missed-at-first-pass:off-west-end:soundsandstage (1 show)
- missed-at-first-pass:off-west-end:stagetopage (1 show)
- missed-at-first-pass:off-west-end:susanelkin (1 show)
- missed-at-first-pass:off-west-end:the-skinny (1 show)
- missed-at-first-pass:off-west-end:theartsdispatch (1 show)
- missed-at-first-pass:off-west-end:theatre-and-tonic (1 show)
- missed-at-first-pass:off-west-end:theatre-south-east (1 show)
- missed-at-first-pass:off-west-end:theatreboard (1 show)
- missed-at-first-pass:off-west-end:theqr (1 show)
- missed-at-first-pass:off-west-end:theupcoming (1 show)
- missed-at-first-pass:off-west-end:timeout-london (1 show)
- missed-at-first-pass:off-west-end:uktheatrenetwork (1 show)
- missed-at-first-pass:off-west-end:viewfromthegods (1 show)
- missed-at-first-pass:west-end:beyondthecurtain (1 show)
- missed-at-first-pass:west-end:boxofficeradio (1 show)
- missed-at-first-pass:west-end:britishtheatrecom (1 show)
- missed-at-first-pass:west-end:cherylmarkosky (1 show)
- missed-at-first-pass:west-end:everything-theatre (1 show)
- missed-at-first-pass:west-end:hollywood-reporter (1 show)
- missed-at-first-pass:west-end:london-box-office (1 show)
- missed-at-first-pass:west-end:london-unattached (1 show)
- missed-at-first-pass:west-end:loureviews (1 show)
- missed-at-first-pass:west-end:musicomh (1 show)
- missed-at-first-pass:west-end:north-west-end (1 show)
- missed-at-first-pass:west-end:nytimes (1 show)
- missed-at-first-pass:west-end:pinkprincetheatre (1 show)
- missed-at-first-pass:west-end:plays-international (1 show)
- missed-at-first-pass:west-end:readaboutstuff (1 show)
- missed-at-first-pass:west-end:seatplan (1 show)
- missed-at-first-pass:west-end:shinylife (1 show)
- missed-at-first-pass:west-end:theartsdispatch (1 show)
- missed-at-first-pass:west-end:theatrebookings (1 show)
- missed-at-first-pass:west-end:west-end-best-friend (1 show)
- missed-at-first-pass:west-end:west-end-wilma (1 show)
- text-missed-at-first-pass:broadway:thewrap (1 show)
- text-missed-at-first-pass:off-broadway:theater-pizzazz (1 show)
- text-missed-at-first-pass:off-broadway:theatermania (1 show)
- text-missed-at-first-pass:off-broadway:timeout (1 show)
- text-missed-at-first-pass:off-broadway:wsj (1 show)
- text-missed-at-first-pass:off-west-end:adventuresintheatreland (1 show)
- text-missed-at-first-pass:off-west-end:express-uk (1 show)
- text-missed-at-first-pass:off-west-end:guardian (1 show)
- text-missed-at-first-pass:off-west-end:londonlivinglarge (1 show)
- text-missed-at-first-pass:off-west-end:theatre-vibe (1 show)
- text-missed-at-first-pass:off-west-end:theatreandtonic (1 show)
- text-missed-at-first-pass:west-end:artsdesk (1 show)
- text-missed-at-first-pass:west-end:bachtrack (1 show)
- text-missed-at-first-pass:west-end:lbc (1 show)
- text-missed-at-first-pass:west-end:londontheatre1 (1 show)
- text-missed-at-first-pass:west-end:telegraph (1 show)
- text-missed-at-first-pass:west-end:timeout-london (1 show)
- text-missed-at-first-pass:west-end:west-end-best-friend (1 show)

## Expected repeats (excluded)

| Class | Cards | Why it is expected |
|---|---|---|
| touch data audit canary marker | 49 | canary: filed on purpose to prove the alert chain works |
| opening night audit | 39 | scheduled per-night opening-night audit/watch log card |
| opening night watch | 27 | scheduled per-night opening-night audit/watch log card |
| commercial data pending review | 22 | owner review queue, one card per batch |
| week review | 4 | weekly report |
| chore bump all updates group across directory | 4 | dependabot landing, one per bump |
| commercial scorecard corrections part | 3 | numbered work batches of one project |
| tech scorecard weekly port | 3 | weekly porting routine (tech-scorecard docs/PORTING.md) files one dated card per week on purpose (BRO-7334) |
