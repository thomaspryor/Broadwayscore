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

Update 2026-10-30: `data/audit/we-season-reference/gap-justifications.json`
now records sourced reasons for misses, and the completeness check reads it
(`referenceCoverage({ justifications })`, validated by
`validateGapJustifications()` in the acceptance suite). Two kinds exist:

- same-production: the entry is an existing row under another title. It
  counts as present only while that row exists and starts within 75 days
  of the entry. Used for `Untold Stories (Hymn & Cocktail Sticks)` =
  `alan-bennetts-untold-stories-west-end-2013` (same Duchess run, the two
  plays of that bill) and `Bring Up the Bodies` = `wolf-hall-west-end-2014`
  (RSC Aldwych repertory pairing, same company and closing date).
- out-of-scope, category `non-professional-company` only: the National
  Youth Theatre REP seasons at the Ambassadors (2013 Prince of Denmark,
  Tory Boyz, Romeo and Juliet; 2014 Private Peaceful / Macbeth / Selfie;
  2015 The Merchant of Venice / Wuthering Heights / Consensual; company
  confirmed on each Theatricalia production page). These leave the
  in-scope denominator and are still printed by the audit. Children's
  shows, magic and solo comedy are deliberately NOT out of scope: the site
  already lists `the-gruffalo-west-end-2010` and `impossible-west-end-2015`.

| Season | Raw matched / reference | In scope | In-scope share | Meets 85% |
| --- | --- | --- | --- | --- |
| 2012-2013 | 52 / 56 | 56 | 93% | yes |
| 2013-2014 | 44 / 52 | 49 | 90% | yes |
| 2014-2015 | 42 / 46 | 45 | 93% | yes |
| 2015-2016 | 51 / 61 | 60 | 85% | yes |
| 2016-2017 | 48 / 52 | 52 | 92% | yes |

Remaining open gaps (real productions to promote; each needs a sourced
closing date, venue validation and supply before it can be added, and none
was added here):

- 2012-2013: Seussical the Musical!; Burn The Floor; Potted Potter;
  Derren Brown: Infamous.
- 2013-2014: Edward II; Jersey Boys (Piccadilly Theatre, March 2014, the
  2008 production's transfer; no 2008 row exists); Relative Values;
  The Silver Tassie; The Elephantom.
- 2014-2015: Peppa Pig's Big Splash; Green Day's American Idiot; McQueen.
- 2015-2016: People, Places and Things (Dorfman Theatre, September 2015);
  The Rocky Horror Show; All On Her Own; Derren Brown: Miracle; The
  Illusionists: Witness The Impossible; Here We Go; Nina Conti: In Your
  Face; Impossible (July 2016 return of the 2015 run, 11 months later,
  beyond the 183-day return window); The Secret Garden.
- 2016-2017: Peter Pan Goes Wrong (Apollo Theatre, October 2016); Dirty
  Dancing (Phoenix Theatre, December 2016); Barber Shop Chronicles;
  Gangsta Granny.

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
