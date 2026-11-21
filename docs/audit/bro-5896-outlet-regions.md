# BRO-5896 outlet-region audit, 2026-11-09

Baseline: `a8dafe8265fadb03cd4d15d299d1b0b542a746aa` (HEAD and origin/main were identical). The supplied 25-test acceptance check passed before edits. Corrected-region reverse auto-clear and contradicted-stamp retraction were already implemented on main; neither was reimplemented.

The current registry had 113 BRO-133 London stamps, rather than the older card snapshot of 121. This audit covers every current stamp and checks the 17 earlier BRO-5896 corrections. Outcome: 3 corrected, 104 retained with evidence, 6 unresolved and unchanged. This is not a claim that every outlet's headquarters was independently verified.

Corrections clear the London-only region, remove the old inference stamps, set isDualMarket for the three global platforms, and record source evidence and regionCorrectedBy. This preserves existing London coverage and prevents a future NYC review from being excluded solely by the old London inference. No private review or core-data file was edited.

Abundant Art and Alt Africa are retained: their own published pages support UK arts coverage. The earlier suggestion to clear them is not adopted. UK regional outlets retain the existing London bucket; this audit does not migrate region taxonomy.

## Measurement and limits

- Read 80,584 review files across the available show corpus. Canonical outlet IDs use buildOutletMaps and normalizeOutlet. Show categories come from shows.json, not review URL paths. Trustworthy evidence uses isReviewContentTrustworthy. Distinct shows, not duplicate review files, are counted.
- The actual region inference pass changes 0 current outlet records before or after the code change. The separate, evidence-backed registry corrections change exactly 3 records: marquee, bnn, grandgoldman. All three have 0 NYC corpus reviews and 0 NYC London-outlet flags, so this change newly releases 0 NYC reviews.
- A replay with only the 113 inferred regions unset, using the same present-day corpus on both implementations, changes proposed stamps from 82 to 51. The stronger threshold prevents 31 weak stamps. This is a counterfactual replay using current evidence, not a reconstruction of evidence available on each original inference date.
- Examples: bnn (one London show, .network) would stamp before and stays unset after; bigissue (three distinct London shows) still stamps; dress-circle-antics (UK domain, four London shows) still stamps. Existing independently supported stamps, including Empire and Abundant Art, are not automatically erased by the new threshold.
- The forward-guard evidence exception changes 600 evidence classifications from null to London. No newly inferred or retracted outlet results in the current corpus. Held/manual/content/ensemble wrong-production decisions and other quality flags remain ineligible. Tests exercise a registered .com blog accumulating its third London show despite the forward guard.
- `node scripts/audit-london-outlet-flags.js --json`: before and after, 2,612 NYC reviews retain the London-outlet flag; 140 carry prior release stamps. These are global audit totals, not 2,612 established false positives. The previously corrected Out in Jersey outlet has one release recorded.
- Scoring delta on the final tree: 80,584 reviews; 0 newly included, 0 newly excluded, 0 T1 flips. Exit 2 is the explicit registry-change notice for these three entries, not a scoring flip. No review-text writes were made.
- New runtime paid fetches, LLM calls and API calls: 0. Existing rebuild callers invoke the stronger local inference. The one-time web evidence checks are not added to a cron.

## Every current inferred outlet

London/NYC are distinct evidence shows from the baseline. Flagged NYC is the count of review files with the reverse guard note. Retain means sufficient evidence to keep the existing UK bucket, not proof of exclusive London coverage. URL links below are sources read as pages; no geographic metadata was extracted from article paths.

| Outlet | London | NYC | Flagged NYC | Decision | Evidence |
| --- | ---: | ---: | ---: | --- | --- |
| empire | 1 | 0 | 0 | Retain | [Publisher evidence](https://uk.linkedin.com/company/empiremag): Publisher profile identifies a UK movie brand and London base. |
| bigissue | 3 | 0 | 0 | Retain | Repeated London coverage (3 distinct shows); see corpus method above. |
| matttrueman | 0 | 0 | 0 | Retain | UK registry domain: matttrueman.co.uk. |
| dress-circle-antics | 4 | 0 | 0 | Retain | UK registry domain: dresscircleantics.co.uk. |
| mrcarlwoodward | 7 | 0 | 0 | Retain | Repeated London coverage (7 distinct shows); see corpus method above. |
| theatre-news | 4 | 0 | 1 | Retain | Repeated London coverage (4 distinct shows); see corpus method above. |
| co | 4 | 0 | 0 | Retain | UK registry domain: stagedoorjoe.co.uk. |
| rhombus-rota | 8 | 0 | 4 | Retain | UK registry domain: rhombusrota.co.uk. |
| londongrip | 4 | 0 | 0 | Retain | UK registry domain: londongrip.co.uk. |
| londonbornandbred | 9 | 0 | 0 | Retain | UK registry domain: londonbornandbred.co.uk. |
| revstanstheatreblog | 14 | 0 | 0 | Retain | UK registry domain: revstanstheatreblog.co.uk. |
| viewfromthegods | 21 | 0 | 0 | Retain | UK registry domain: viewfromthegods.co.uk. |
| jewishnews | 8 | 0 | 0 | Retain | UK registry domain: jewishnews.co.uk. |
| operationlivetheatre | 2 | 0 | 0 | Retain | [Publisher evidence](https://www.operationlivetheatre.com/post/top-shows-to-see-in-london): Own editorial guide covers several London productions. |
| shinylife | 4 | 0 | 0 | Retain | UK registry domain: shinylife.co.uk. |
| onin | 12 | 0 | 2 | Retain | UK registry domain: onin.london. |
| londonmumsmagazine | 5 | 0 | 0 | Retain | Repeated London coverage (5 distinct shows); see corpus method above. |
| strandmagazine | 3 | 0 | 0 | Retain | UK registry domain: strandmagazine.co.uk. |
| unmissabletheatre | 11 | 0 | 0 | Retain | UK registry domain: unmissabletheatre.co.uk. |
| fringereview | 72 | 0 | 1 | Retain | UK registry domain: fringereview.co.uk. |
| londontheatrehub | 2 | 0 | 0 | Retain | UK registry domain: londontheatrehub.co.uk. |
| londontheatredirect | 67 | 2 | 0 | Retain | Repeated London coverage (67 distinct shows); see corpus method above. |
| ikonlondonmagazine | 2 | 0 | 0 | Retain | [Publisher evidence](https://www.ikonlondonmagazine.com/about-us/): Own about page identifies its London base and lifestyle coverage. |
| thetheatreflyer-co-uk | 4 | 0 | 0 | Retain | UK registry domain: thetheatreflyer.co.uk. |
| all-allam | 2 | 0 | 0 | Retain | [Publisher evidence](https://all-allam.com/): Official actor archive covers London theatre, including the Old Vic and Orange Tree. |
| primarytimes | 1 | 0 | 0 | Retain | UK registry domain: primarytimes.co.uk. |
| openairtheatreheritage | 1 | 0 | 0 | Retain | [Publisher evidence](https://openairtheatreheritage.com/): Official history of Regent's Park Open Air Theatre identifies its London venue. |
| marquee | 1 | 0 | 0 | Corrected | Global performing-arts streaming platform, including international theatre; https://www.marquee.tv/help/article/what-is-marquee-tv (checked 2026-11-09). London-only inference is inappropriate for worldwide streamed productions. |
| myreviewer | 1 | 0 | 0 | Unresolved | No independently verified geographic evidence; existing stamp left unchanged. |
| chelmsfordtheatre | 2 | 0 | 1 | Retain | UK registry domain: chelmsfordtheatre.co.uk. |
| dayoutwiththekids | 1 | 0 | 0 | Retain | UK registry domain: dayoutwiththekids.co.uk. |
| muddystilettos | 3 | 0 | 0 | Retain | UK registry domain: london.muddystilettos.co.uk. |
| westwaleschronicle | 1 | 0 | 0 | Retain | UK registry domain: westwaleschronicle.co.uk. |
| cherylmarkosky | 5 | 0 | 0 | Retain | Repeated London coverage (5 distinct shows); see corpus method above. |
| theatreboard | 14 | 0 | 1 | Retain | Repeated London coverage (14 distinct shows); see corpus method above. |
| visit-london | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.visitlondon.com/about-us): Official visitor guide operated by London & Partners. |
| bestoftheatre | 30 | 0 | 2 | Retain | UK registry domain: bestoftheatre.co.uk. |
| soundsandstage | 5 | 0 | 0 | Retain | Repeated London coverage (5 distinct shows); see corpus method above. |
| jackstage | 13 | 0 | 3 | Retain | UK registry domain: jackstage.co.uk. |
| songsbehindthemusic | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.songsbehindthemusic.com/step-behind-the-stage/): Own theatre index documents repeated coverage of London venues. |
| 1883magazine | 21 | 0 | 0 | Retain | Repeated London coverage (21 distinct shows); see corpus method above. |
| jacktheladmag | 3 | 0 | 0 | Retain | Repeated London coverage (3 distinct shows); see corpus method above. |
| cineramafilm | 4 | 0 | 0 | Retain | Repeated London coverage (4 distinct shows); see corpus method above. |
| timboatswain | 1 | 0 | 0 | Retain | [Publisher evidence](https://timboatswain.wixsite.com/website): Own site documents UK theatre coverage and St Albans civic activities. |
| sueterryvoices | 2 | 0 | 0 | Retain | [Publisher evidence](https://www.sueterryvoices.com/): Own homepage identifies a Soho, London office. |
| musicaltheatremusings | 5 | 0 | 0 | Retain | UK registry domain: musicaltheatremusings.co.uk. |
| emmatheatrics | 2 | 0 | 0 | Retain | [Publisher evidence](https://emmatheatrics.wixsite.com/emma-theatrics/articles): Own portfolio lists several London productions and a UK tour. |
| theqr | 8 | 0 | 1 | Retain | UK registry domain: theqr.co.uk. |
| musicalmanda | 7 | 0 | 0 | Retain | Repeated London coverage (7 distinct shows); see corpus method above. |
| onceaweektheatre | 14 | 0 | 0 | Retain | Repeated London coverage (14 distinct shows); see corpus method above. |
| getthechance | 14 | 0 | 0 | Retain | UK registry domain: getthechance.wales. |
| susanelkin | 5 | 0 | 0 | Retain | UK registry domain: susanelkin.co.uk. |
| chiswickcalendar | 7 | 0 | 0 | Retain | UK registry domain: chiswickcalendar.co.uk. |
| beyondthecurtain | 10 | 0 | 0 | Retain | UK registry domain: beyondthecurtain.co.uk. |
| londonatlarge | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.londonatlarge.com/): Publisher explicitly describes its London events service. |
| partially-obstructed-view | 44 | 0 | 0 | Retain | Repeated London coverage (44 distinct shows); see corpus method above. |
| carlwoodward | 4 | 0 | 0 | Retain | Repeated London coverage (4 distinct shows); see corpus method above. |
| islingtontribune | 63 | 0 | 0 | Retain | UK registry domain: islingtontribune.co.uk. |
| jazzwise | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.jazzwise.magazine.co.uk/): Publisher subscription page identifies a UK jazz magazine. |
| theatrebookings | 3 | 0 | 0 | Retain | Repeated London coverage (3 distinct shows); see corpus method above. |
| timeandleisure | 3 | 0 | 0 | Retain | UK registry domain: timeandleisure.co.uk. |
| theatreinedinburgh | 0 | 0 | 0 | Retain | UK registry domain: theatreinedinburgh.co.uk. |
| redbuslondinium | 13 | 0 | 0 | Retain | UK registry domain: redbuslondinium.uk. |
| timcrouchtheatre | 1 | 0 | 0 | Retain | UK registry domain: timcrouchtheatre.co.uk. |
| essentialsurrey | 5 | 0 | 0 | Retain | UK registry domain: essentialsurrey.co.uk. |
| juliarank | 2 | 0 | 0 | Retain | [Publisher evidence](https://www.londontheatre.co.uk/info/writers/julia-rank): Publisher identifies the writer as a London Theatre reviewer. |
| uktw | 2 | 0 | 0 | Retain | UK registry domain: uktw.co.uk. |
| manic-mumdays | 1 | 0 | 0 | Retain | UK registry domain: manic-mumdays.co.uk. |
| far-out-magazine | 2 | 0 | 0 | Retain | UK registry domain: faroutmagazine.co.uk. |
| seenanythinglately | 1 | 0 | 0 | Retain | [Publisher evidence](https://seenanythinglately.wordpress.com/): Own masthead explicitly describes London theatre coverage. |
| wheeliegoodshow | 6 | 0 | 0 | Retain | Repeated London coverage (6 distinct shows); see corpus method above. |
| stage-talk-magazine | 0 | 0 | 0 | Retain | [Publisher evidence](https://stagetalkmagazine.com/about-us/home-2): Own about page identifies the Bristol review team. |
| bnn | 1 | 0 | 0 | Corrected | BNN Breaking was based in Hong Kong and aggregated international news; https://en.wikipedia.org/wiki/BNN_Breaking and https://mediabiasfactcheck.com/bnn-breaking-bias-and-credibility/ (checked 2026-11-09). One West End show did not establish a London outlet. |
| the-culture-pages | 1 | 0 | 0 | Retain | UK registry domain: culturepages.co.uk. |
| jupiterhadley | 1 | 0 | 0 | Retain | [Publisher evidence](https://jupiterhadley.com/): Own homepage and corpus document England outings and London cultural coverage. |
| artshub | 5 | 0 | 0 | Retain | UK registry domain: artshub.co.uk. |
| maturetimes | 22 | 0 | 0 | Retain | UK registry domain: maturetimes.co.uk. |
| hackneycitizen | 2 | 0 | 0 | Retain | UK registry domain: hackneycitizen.co.uk. |
| curtainsup | 3 | 0 | 0 | Retain | Repeated London coverage (3 distinct shows); see corpus method above. |
| theamerican | 2 | 0 | 0 | Retain | UK registry domain: theamerican.co.uk. |
| markaspen | 6 | 0 | 0 | Retain | Repeated London coverage (6 distinct shows); see corpus method above. |
| musicomh | 6 | 0 | 0 | Retain | Repeated London coverage (6 distinct shows); see corpus method above. |
| littlelondonwhispers | 2 | 0 | 0 | Retain | [Publisher evidence](https://littlelondonwhispers.substack.com/about): Own about page explicitly describes London culture coverage. |
| counselmagazine | 2 | 0 | 0 | Retain | UK registry domain: counselmagazine.co.uk. |
| mildconcern | 2 | 0 | 0 | Unresolved | No independently verified geographic evidence; existing stamp left unchanged. |
| kiddoadventures | 2 | 0 | 0 | Retain | [Publisher evidence](https://kiddoadventures.com/): Own homepage describes trips from London and UK family activities. |
| thechelseacitizen | 1 | 0 | 0 | Retain | [Publisher evidence](https://thechelseacitizen.com/about/): Publisher describes a local newspaper for Chelsea, London. |
| mycultural | 2 | 0 | 0 | Unresolved | No independently verified geographic evidence; existing stamp left unchanged. |
| aviewfromrowjay | 7 | 0 | 0 | Retain | Repeated London coverage (7 distinct shows); see corpus method above. |
| nub-news | 2 | 0 | 0 | Retain | [Publisher evidence](https://www.ipso.co.uk/wp-content/uploads/2025/07/NUB-NEWS-ANNUAL-IPSO-STATEMENT-.pdf): Publisher's IPSO statement identifies England/Wales coverage and a Crewe office. |
| whatsgoodtodo | 2 | 0 | 0 | Retain | [Publisher evidence](https://whatsgoodtodo.com/about_us/): Own about page identifies a UK review team and England/Wales company. |
| darkusmagazine | 1 | 0 | 0 | Retain | [Publisher evidence](https://darkusmagazine.weebly.com/): Original publisher homepage identifies a Newcastle upon Tyne base. |
| immersiverumours | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.immersiverumours.com/): Own masthead and current coverage focus on London immersive shows. |
| number9reviews | 2 | 0 | 0 | Retain | [Publisher evidence](https://number9reviews.blogspot.com/2020/06/online-sitcom-review-behind-closed.html): Own masthead describes Greater Manchester and UK-wide arts coverage. |
| timesbookshop | 1 | 0 | 0 | Retain | UK registry domain: timesbookshop.co.uk. |
| ticketswitch | 1 | 0 | 0 | Unresolved | No independently verified geographic evidence; existing stamp left unchanged. |
| soundbehindcurtain | 2 | 0 | 0 | Retain | [Publisher evidence](https://www.soundbehindcurtain.com/about): Own about page identifies London/Edinburgh reviewers. |
| thepegreview | 1 | 0 | 0 | Retain | [Publisher evidence](https://thepegreview.com/about/): Own about page explicitly describes London fringe coverage. |
| travelbeginsat40 | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.travelbeginsat40.com/about/): Global travel team includes UK/London arts writers; keep existing UK geography, do not assert London-only coverage. |
| theatrereviewsnorth | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.theatrereviewsnorth.com/): Own masthead describes theatre coverage across northern England. |
| itgirlworld | 1 | 0 | 0 | Retain | UK registry domain: itgirlworld.co.uk. |
| grandgoldman | 2 | 0 | 0 | Corrected | Global news and travel publication covering international destinations, not a London theatre outlet; https://grandgoldman.com/ and https://grandgoldman.com/pages/careers (checked 2026-11-09). Corpus includes regional coverage as well as two London shows. |
| the-rendition | 3 | 0 | 0 | Retain | UK registry domain: therendition.co.uk. |
| abundantart | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.abundantart.net/about-us/): Own team page identifies London arts practice and UK cultural institutions; official company profile also lists London. |
| ratedreviewed | 2 | 0 | 0 | Retain | UK registry domain: ratedreviewed.co.uk. |
| nick-holmes-music | 1 | 0 | 0 | Retain | [Publisher evidence](https://nick-holmes-music.com/about-me/): Own biography identifies Manchester home and UK music coverage. |
| alt-africa | 1 | 0 | 0 | Retain | [Publisher evidence](https://alt-africa.com/about/): Own about page explicitly identifies its UK creative-community focus. |
| inspiringtravelexperiences | 1 | 0 | 0 | Unresolved | No independently verified geographic evidence; existing stamp left unchanged. |
| tabinthecity | 1 | 0 | 0 | Retain | UK registry domain: tabinthecity.co.uk. |
| just-retiring | 0 | 0 | 0 | Unresolved | No independently verified geographic evidence; existing stamp left unchanged. |
| buzzmag | 1 | 0 | 1 | Retain | UK registry domain: buzzmag.co.uk. |
| frostmagazine | 1 | 0 | 0 | Retain | [Publisher evidence](https://www.frostmagazine.com/): Editor's own introductory article identifies a London base. |
| hannah-come-lately | 1 | 0 | 0 | Retain | [Publisher evidence](https://hannahcomelately.substack.com/p/hannahs-culture-diaries-late-march): Own introduction describes cultural coverage mainly in London. |

## Earlier corrections preserved

- consequence: us; New York-based per en.wikipedia.org/wiki/Consequence_(website).
- ign: us; US-run, HQ San Francisco (en.wikipedia.org/wiki/IGN).
- san-diego-story: us; San Diego arts site (sandiegostory.com); BRO-5890 finding.
- fjord-review: region cleared; Fjord Review Inc., Toronto, Canada (fjordreview.com/pages/about).
- outinjersey: us; New Jersey LGBTQ magazine (outinjersey.net); BRO-5890 finding.
- letterboxd: region cleared; Headquartered in Auckland, NZ (en.wikipedia.org/wiki/Letterboxd); global platform.
- staybook: region cleared; New Delhi address (staybook.in/contact-us).
- ground: region cleared; Ground News, Kitchener, Ontario (ground.news/about); global aggregator.
- priceless: region cleared; Mastercard Priceless, global experiences platform (35+ destinations).
- gauravnijjer: region cleared; "based in New Delhi, India" (gauravnijjer.com).
- wave: us; pod.wave.co footer: "Built in New York".
- jolienstheatrediary: region cleared; "Based in Dublin" (jolienstheatrediary.com).
- open-letters-review: us; US literary review (openlettersreview.com, masthead Steve Donoghue / Sam Sacks); BRO-5890 finding.
- thecontextengine: region cleared; Aggregator summarising other outlets, .ca domain (thecontextengine.ca).
- theconversation: region cleared; International network, ten editions in 14 countries (theconversation.com/uk/who-we-are).
- 1blocknews: region cleared; Global news aggregator, no base (1blocknews.com/about).
- soz6: region cleared; Registered in Baku, Azerbaijan (soz6.com/haqqimizda).

## Unresolved evidence

Remaining IDs: myreviewer, mildconcern, mycultural, ticketswitch, inspiringtravelexperiences, just-retiring. Their existing regions are unchanged. Public about/home/review pages and indexed searches did not establish enough reliable geography to alter their flags. MyReviewer returned a 502/unavailable page; Inspiring Travel Experiences and Just Retiring review/about pages were unavailable; Mild Concern had only an older WordPress archive with an unverified connection to the registered Substack; My Cultural Life showed London articles plus a Broadway reference but did not establish market scope; Ticketswitch exposed a sales catalogue without sufficient geographic editorial evidence. Completing these entries needs accessible publisher evidence, archived pages, or a separate authorized scraping investigation. None has a NYC London-outlet flag in the supplied corpus.

## Verification

- `node --test scripts/lib/outlet-region-map.test.mjs`: 25/25 baseline; added threshold expectation failed before the implementation; final suite 27/27.
- `node --test --test-timeout 300000 scripts/lib/outlet-region-map.test.mjs scripts/lib/wrong-production-autoclear-london-outlet.test.mjs scripts/lib/cross-market-guard.test.mjs`: 92/92 pass.
- `rg -l "outlet-region-map|rebuild-all-reviews" tests scripts --glob "*.test.*"` followed by `xargs node --test --test-timeout 300000`: 3,156 pass, 7 environment/launcher failures. Five push-retry cases pass with `RUNNER_TEMP=/tmp` (18-test file passes). The TypeScript engine file passes with `node --import tsx --test --test-timeout 300000 tests/unit/engine.test.ts` (34 tests). The remaining discovery-writer integration fixture cannot mkdir in the read-only private review-texts tree; the other six tests in its file pass when that fixture is excluded. The writer itself is unchanged from origin/main.
- Registry taxonomy and two adjacent registry regression files: 11/11 pass.
- `node scripts/test-temporal-override-regression.js`: OVERALL PASS, both suites green.
- `node scripts/scoring-delta.js`: final exit 2 for registry drift, zero review/T1 flips as detailed above.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`: only failed gate is missing actionlint (exit 127); the remaining audits pass. Log was read.
- `git log -S "regionEvidenceMarket" --oneline -5 -- scripts/lib/outlet-region-map.js` could not complete because history blobs require lazy fetching into the read-only parent .git object store. HEAD=origin/main and the passing baseline check establish the current-main behavior without modifying history.
- Writer/caller wiring: rebuild-all-reviews collects canonical per-show evidence through regionEvidenceMarket and passes outletMarketShowsRaw into backfillMissingOutletRegions. The existing reverse auto-clear still receives outletRegionExplicitlyNotLondon in both rebuild-all-reviews and scoring-delta.

REMAINING: Resolve the six publisher-evidence exceptions above; no uncertain registry change was made.
