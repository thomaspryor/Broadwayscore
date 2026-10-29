# BRO-6450 verification snapshot, 2026-10-29

The reference builder and advisory completeness check are already present on
main. The card's acceptance command named a missing file. The new
`tests/unit/we-historical-season-completeness.test.mjs` checks the committed
reference data and calls the existing `referenceCoverage()` implementation.
It needs no private data or network access. Existing integration tests in
`scripts/lib/we-season-reference.test.mjs` cover the advisory audit wiring.

The committed lists use Theatricalia venue histories plus Theatre Record,
Official London Theatre, WhatsOnStage, Guardian reviews, or Wikipedia venue
articles as recorded per entry. Their builder is
`scripts/build-we-season-reference.js`; each season JSON documents its scope,
source names, dated production URLs, uncorroborated entries and exclusions.
The builder does not ingest the Olivier eligibility lists proposed in the
card. An Olivier eligibility cross-check remains outstanding; these tests
validate the recorded provenance structure, not the external sources' claims.

Read-only verification against the supplied core data gives:

| Season | Matched / reference | Reported share | Meets 85% | Displayable share | Unresolved press-night dates |
| --- | --- | --- | --- | --- | --- |
| 2012-2013 | 51 / 56 | 91% | yes | 21% | 0 |
| 2013-2014 | 43 / 52 | 83% | no | 65% | 0 |
| 2014-2015 | 42 / 46 | 91% | yes | 57% | 0 |
| 2015-2016 | 51 / 61 | 84% | no | 57% | 0 |
| 2016-2017 | 48 / 52 | 92% | yes | 78% | 18 |

Reproduce each row with
`node scripts/audit-we-historical-season.js --season=YYYY-YYYY --json`.
All five commands currently exit 1. Completeness remains advisory, as already
implemented; no gate or threshold was changed. Displayable share must reach
70%, and all unresolved press-night dates must be repaired, for these season
audits to pass. No production or review records changed in this follow-up.

All 15 productions named in the card's evidence are already represented in
the supplied West End rows, including the historical runs of The Weir,
Blithe Spirit, Kinky Boots and Ghosts. Top Hat opened in May 2012, before the
first season covered here, and its existing 2012 row was retained.

## Unmatched reference entries

These are audit matches still to resolve, not approved exclusions. No entry
was removed to improve the denominator. Production identity, dates, scope,
retired IDs and venue validation need checking before any promotion. Adding
shows, moving private review files and running the backfill supply recipe
are outside this unattended worker's permitted actions.

2013-2014 needs at least two more reference matches to reach 85%; 2015-2016
needs at least one. The other seasons meet the threshold but still have gaps.

- 2012-2013: Seussical the Musical!; Burn The Floor; Untold Stories (Hymn &
  Cocktail Sticks); Potted Potter; Derren Brown: Infamous.
- 2013-2014: Edward II; Prince of Denmark; Tory Boyz; Romeo and Juliet
  (Ambassadors Theatre, September 2013); Jersey Boys (Piccadilly Theatre,
  March 2014); Relative Values; The Silver Tassie; Bring Up the Bodies;
  The Elephantom.
- 2014-2015: Private Peaceful / Macbeth / Selfie; Peppa Pig's Big Splash;
  Green Day's American Idiot; McQueen.
- 2015-2016: People, Places and Things (Dorfman Theatre, September 2015);
  The Rocky Horror Show; The Merchant of Venice / Wuthering Heights /
  Consensual; All On Her Own; Derren Brown: Miracle; The Illusionists:
  Witness The Impossible; Here We Go; Nina Conti: In Your Face; Impossible;
  The Secret Garden.
- 2016-2017: Peter Pan Goes Wrong (Apollo Theatre, October 2016); Dirty
  Dancing (Phoenix Theatre, December 2016); Barber Shop Chronicles;
  Gangsta Granny.

One gap needs title reconciliation rather than assuming a missing show:
the reference's `Untold Stories (Hymn & Cocktail Sticks)` has the same
Duchess Theatre run dates (2013-03-22 to 2013-06-15) as
`alan-bennetts-untold-stories-west-end-2013`, titled
`Alan Bennett's Untold Stories`. The current matcher does not equate them.
No broad title-matching rule was added for this one potential alias.

Existing rows for American Idiot (2016), People, Places & Things (2016),
Peter Pan Goes Wrong (2015), Dirty Dancing (2013) and Jersey Boys (2021)
do not cover the reference runs listed above. Their later or earlier dates
must not silently fill these gaps. Missing closing dates in several
reference entries also require source research before promotion.

## 2012-2013 supply still outstanding

The supplied reviews.json has these counts of finite assigned scores:

| Show ID | Scored reviews | Review files | Invalid-tier files |
| --- | --- | --- | --- |
| hedda-gabler-west-end-2012 | 5 | 18 | 14 |
| once-west-end-2013 | 3 | 6 | 3 |
| alan-bennetts-untold-stories-west-end-2013 | 3 | 4 | 1 |
| the-ladykillers-west-end-2013 | 5 | 7 | 1 |
| monty-pythons-spamalot-west-end-2012 | 0 | 3 | 2 |

Hedda Gabler's invalid-tier files remain present. The earlier card comment
identified 13 as reviews of the 2016 production; this follow-up did not
reclassify or move them. Once, Untold Stories and Spamalot remain below five
scored reviews. The Ladykillers now reaches five. Finishing the supply
recipe, checking the Hedda file destinations and resolving the 2016-2017
press-night dates require separate permitted private-data/supply work.

No paid fetches, LLM calls or external API calls were introduced or run by
this follow-up. No cron, workflow or private data was changed.
