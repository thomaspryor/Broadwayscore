# BRO-5530 capitalization sweep outcome

Research date: October 28, 2026. Baseline: checkout `cb17c005`, using the runner-supplied `data/commercial.json` and `data/shows.json`.

The acceptance test already passed before the work, but it checks plan validity, not capitalization coverage. Of the 18 specifically named shows, 15 already had sourced figures and three still had no figure. Including the four named TBD examples and every currently empty TBD row gives 44 distinct scoped records. This report accounts for all 44: 17 existing figures retained, four new Form D figures proposed, 22 explicit no-figure results, and one exclusion. Other historical records outside that scope were not added to this research batch.

The two pending plans contain 27 actions across nine records, with 25 and two actions respectively. The private data files were never written. All oldValue fields were filled from the supplied checkout through `completeActions` in `scripts/new-fix-plan.js`, then the same module built the plans. Its exported API was used with an explicit checkout data loader because the CLI otherwise selects and refreshes a separate core-data clone outside this checkout.

## New figures

Each issuer was matched using the filing body, named producers and production credits. SEC submissions histories confirm that these are the latest D/D-A filings for the four issuers, with no additional submissions-history files. None has an explicit capitalized-at clarification, so the fully sold offerings use the sold amount and the other two retain their offering ceiling. The existing commercial field writer derives `capitalizationBasis` from the source wording.

| Production | Before | Proposed capitalization | Filing and production match |
| --- | --- | --- | --- |
| `the-heidi-chronicles-2015` | null | $3,800,000 (fully sold) | [2015-05-08 primary XML](https://www.sec.gov/Archives/edgar/data/1617380/000161738015000001/primary_doc.xml), [xslFormDX01](https://www.sec.gov/Archives/edgar/data/1617380/000161738015000001/xslFormDX01/primary_doc.xml), [producer credits](https://www.ibdb.com/broadway-production/the-heidi-chronicles-498692) |
| `it-shoulda-been-you-2015` | null | $7,000,000 (fully sold) | [2015-06-15 primary XML](https://www.sec.gov/Archives/edgar/data/1622141/000162214115000001/primary_doc.xml), [xslFormDX01](https://www.sec.gov/Archives/edgar/data/1622141/000162214115000001/xslFormDX01/primary_doc.xml), [producer credits](https://www.ibdb.com/broadway-production/it-shoulda-been-you-498636) |
| `skylight-2015` | null | $3,500,000 (offering ceiling, up to) | [2015-02-17 primary XML](https://www.sec.gov/Archives/edgar/data/1633128/000114420415009736/primary_doc.xml), [xslFormDX01](https://www.sec.gov/Archives/edgar/data/1633128/000114420415009736/xslFormDX01/primary_doc.xml), [producer credits](https://www.ibdb.com/broadway-production/skylight-497982) |
| `the-visit-2015` | null | $7,000,000 (offering ceiling, up to) | [2015-03-31 primary XML](https://www.sec.gov/Archives/edgar/data/1631276/000163127615000002/primary_doc.xml), [xslFormDX01](https://www.sec.gov/Archives/edgar/data/1631276/000163127615000002/xslFormDX01/primary_doc.xml), [producer credits](https://www.rcitheatricals.com/the-visit/) |

Heidi Chronicles: the amended offering and sold amount both equal $3.8M; Jeffrey Richards, Jerry Frankel, Susan Gallin and Mary Lu Roffe match the Broadway credits. It Shoulda Been You: both amounts equal $7M; Daryl Roth, Jayne Baron Sherman and Jane Bergere match. Skylight: $3.5M maximum, $1,351,875 sold; Scott Rudin and Robert Fox match. The Visit: $7M maximum, $0 sold at filing; Thomas Kirdahy, Tom Smedes, Hugh Hayes and Edgar Bronfman, Jr. match. A $0 pre-sale figure does not establish the final financing outcome.

## Existing figures retained

These are the current supplied records, not newly researched replacements. The links below are the citations already present in capitalizationSource. No amount, source wording, estimate flag or designation on these 17 records is changed.

| Production | Capitalization on file | Citation on file |
| --- | --- | --- |
| `liberation` | $5,525,000 | [source 1](https://www.sec.gov/Archives/edgar/data/2075411/000207541126000001/primary_doc.xml) |
| `oedipus` | $6,000,000 | [source 1](https://www.broadwayworld.com/article/Exclusive-Inside-the-Numbers-Who-Benefited-and-Why-Broadway-Still-Needs-a-Tax-Credit-20250904), [source 2](https://www.sec.gov/Archives/edgar/data/2073494/000207349425000001/xslFormDX01/primary_doc.xml) |
| `all-out` | $5,000,000 | [source 1](https://www.sec.gov/Archives/edgar/data/2085331/000208533125000002/xslFormDX01/primary_doc.xml) |
| `bob-fosses-dancin-2023` | $15,000,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1899007/000189900721000001/xslFormDX01/primary_doc.xml) |
| `a-beautiful-noise-the-neil-diamond-musical-2022` | $20,000,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1897092/000189709221000001/xslFormDX01/primary_doc.xml) |
| `death-of-a-salesman` | $8,900,000 | [source 1](https://www.hollywoodreporter.com/business/business-news/broadway-box-office-death-salesman-cats-the-jellicle-ball-1236671126/) |
| `allegiance-2015` | $13,000,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1561172/000156117214000001/xslFormDX01/primary_doc.xml) |
| `on-the-town-2014` | $8,500,000 | [source 1](https://www.nytimes.com/2015/01/21/theater/on-the-town-producers-keep-faith-in-their-investment.html) |
| `holler-if-ya-hear-me-2014` | $8,000,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1611459/000161145914000001/xslFormDX01/primary_doc.xml) |
| `the-bridges-of-madison-county-2014` | $8,488,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1574928/000157492814000001/xslFormDX01/primary_doc.xml) |
| `betrayal-2013` | $4,200,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1579288/000114420413040238/xslFormDX01/primary_doc.xml) |
| `the-testament-of-mary-2013` | $2,500,000 | [source 1](https://www.sarasotamagazine.com/arts-and-entertainment/2013/11/how-to-invest-in-a-broadway-show), [source 2](https://www.sec.gov/Archives/edgar/data/1569779/000114420413009686/xslFormDX01/primary_doc.xml) |
| `the-anarchist-2012` | $2,450,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1552175/000155217513000001/xslFormDX01/primary_doc.xml) |
| `leap-of-faith-2012` | $14,650,000 | [source 1](https://www.sec.gov/Archives/edgar/data/1480368/000148036812000002/xslFormDX01/primary_doc.xml) |
| `jerusalem-2011` | $3,000,000 | [source 1](https://archive.nytimes.com/artsbeat.blogs.nytimes.com/2011/05/25/jerusalem-gets-four-week-extension-on-broadway/) |
| `joe-turners-come-and-gone` | $8,000,000 | [source 1](https://therainmakerscollective.com/Q&A/joe-turners-come-gone-qa-and-investment-memo/) |
| `dirty-dancing` | $5,000,000 | Industry-source draft budget already on file; no public amount citation supplied. |

Dirty Dancing is already $5M from an industry-source draft budget. Its public production-announcement links establish the engagement, not that amount. It remains untouched; this sweep does not independently verify that private source.

## No-figure outcomes

Each line is an explicit no-figure reason for the card Outcome. A negative search means no figure was verified in these sources, not that no filing or private budget exists. Title searches can miss opaque LLCs. Ambiguous related-person hits were not assigned to productions. Five of these results are also proposed as capitalizationSource edits: Sunset Boulevard, Fela!, The Lyons, Beaches and 860.

| Production | One-line no-figure reason and production citation | Search evidence |
| --- | --- | --- |
| `the-rocky-horror-show` | Commercial producers Trafalgar Entertainment and The Dodgers join the producing credits from June 23, 2026; retained in scope. No verified capitalization or title-matched Form D located. [Current production credits](https://www.ibdb.com/broadway-production/the-rocky-horror-show-544011) | `rocky-title` |
| `sunset-boulevard-2017` | Broadway Journal explicitly reported the 2017 revival budget as undisclosed; title and Grade/Linnit searches did not establish a matching issuer. The $13M in that article is the 1994 original. [Production/source](https://www.broadwayjournal.com/p/sunset-boulevard-storms-the-palace-in-previews) | `sunset-specific`, `sunset-producer`, `sunset-producer-grade` |
| `fela-2012` | No separate budget found for the 2012 return engagement; the only title-matched Form D is from 2009 and belongs to the original run. [Production/source](https://www.ibdb.com/broadway-production/fela-493032) | `fela-title`, `fela-hendel`, `fela-exact` |
| `the-lyons-2012` | No matched offering under the exact title, Kathleen K. Johnson or Niko Companies; the stored SEC link is J.Crew, not this production. [Production/source](https://www.ibdb.com/broadway-production/the-lyons-491879) | `lyons-exact`, `lyons-producer`, `lyons-gm` |
| `beaches` | No title or Maloney/Prezioso Form D match; production credits and closing coverage supplied no verified budget. [Production/source](https://www.ibdb.com/broadway-production/beaches-a-new-musical-545267) | `beaches-title`, `beaches-producer-retry` |
| `billy-crystal-860` | Commercial Broadway solo show, but no verified budget in the consulted production coverage or Billy/Janice Crystal Form D searches. [Production/source](https://www.ibdb.com/broadway-production/860-547321) | `860-producer-retry`, `860-janice` |
| `small-mouth-sounds` | Rudin/Diller Broadway production; no title-matched offering or budget in the consulted announcement. Producer search returned other named productions, not a verified issuer for this play. [Production/source](https://www.ibdb.com/broadway-production/small-mouth-sounds-548034) | `small-mouth`, `rudin-2026` |
| `dreamgirls` | Announced Broadway revival with Jennifer Hudson producing; no budget in that announcement or title-matched offering in the searched window. [Production/source](https://blackamericaweb.com/2026/02/20/jennifer-hudson-dreamgirls-broadway-revival/) | `dreamgirls-title` |
| `private-lives` | Announced commercial revival led by Jeffrey Richards and Playful Productions; no budget in the announcement or exact-title Form D match in the searched window. [Production/source](https://www.broadway.com/buzz/205410/noel-coward-comedy-private-lives-will-come-to-broadway-for-the-2026-27-season/) | `private-lives-retry` |
| `10-things-i-hate-about-you-on-broadway` | Official site confirms a forthcoming Broadway musical; no verified budget there or exact-title Form D match in the searched window. [Production/source](https://10thingsbroadway.com/) | `10-things` |
| `warriors` | Broadway Journal reported no SEC capitalization disclosure on August 12, 2026; no title-plus-Broadway Form D match in the follow-up search. [Production/source](https://www.broadwayjournal.com/p/broadway-stages-a-musical-comeback) | `warriors-retry` |
| `downstate` | Commercial Rudin/Diller transfer; title hits belong to Pierrepont Therapeutics, not the play. No uniquely matched offering or verified budget established. [Production/source](https://www.shubert.nyc/press/downstate-by-bruce-norris-to-premiere-on-broadway-this-fall-directed-by-joe-mantello/) | `downstate`, `rudin-2026` |
| `three-days-of-rain` | David Binder commercial revival confirmed by the theater owner; no budget in that announcement or exact-title Form D match in the searched window. [Production/source](https://shubert.nyc/press/three-days-of-rain-announces-theatre-dates-and-design-team/) | `three-days` |
| `blue-man-group-a-new-holiday-surprise` | New Broadway holiday production, distinct from the ongoing brand; no budget in the announcement or Blue Man Form D match in the searched window. [Production/source](https://www.broadway.com/buzz/207720/have-a-blue-christmas-tickets-now-on-sale-for-broadways-blue-man-group-a-new-holiday-surprise/) | `blue-man` |
| `wanted` | Broadway Journal reported no SEC capitalization disclosure on August 12, 2026; no verified offering in the narrow Wanted-plus-theatrical follow-up search. [Production/source](https://www.broadwayjournal.com/p/broadway-stages-a-musical-comeback) | `wanted-retry` |
| `let-the-good-times-roll` | Aiming for a Broadway transfer following Phoenix; no verified capitalization in the consulted announcement or exact-title Form D match. [Production/source](https://playbill.com/article/jack-viertel-conceived-let-the-good-times-roll-musical-aiming-for-broadway-next-season) | `good-times` |
| `cat-on-a-hot-tin-roof` | Seaview commercial revival rights confirmed by its law firm; no capitalization in that announcement or exact-title Form D match in the searched window. [Production/source](https://www.loeb.com/en/newsevents/news/2026/04/loeb-guides-seaview-in-acquisition-of-rights-to-pulitzer-prize-winning-play-cat-on-a-hot-tin-roof) | `cat-roof-retry` |
| `angels-in-america` | No verified budget in the consulted 2018 revival coverage. NYA Fund D and the Space Angels funds do not establish a producer-matched theatrical offering. [Production/source](https://www.broadwaynews.com/the-risks-and-rewards-of-two-part-plays-on-broadway/) | `angels` |
| `present-laughter-2017` | Frobisher LLC offers $4.25M and names Jordan Roth, but the filing does not identify the play; the producer had other contemporary projects. No independently matched issuer or verified budget established. [Production/source](https://www.ibdb.com/broadway-production/present-laughter-510583) | `present`, `present-producer` |
| `fish-in-the-dark-2015` | Recoupment coverage gives no capitalization amount. Sons of Leo LLC names Scott Rudin and offers $4.75M, but no production-specific link was established, so it is not used. [Production/source](https://www.theatermania.com/news/larry-davids-record-setting-fish-in-the-dark-recoups-investment_72980/) | `fish-title`, `rudin-2015` |
| `living-on-love-2015` | No verified budget in the consulted closing coverage or title-matched Form D. The broader Nugent search did not establish a production-specific issuer. [Production/source](https://www.nytix.com/news/living-on-love-closes-after-one-month) | `living-love`, `living-producer-final` |
| `the-amish-project` | IBDB confirms the forthcoming Broadhurst solo play; no verified capitalization or exact-title Form D match established as of the research date. [Production/source](https://www.ibdb.com/broadway-production/the-amish-project-548608) | `amish-exact` |

The Lyons correction also removes [the stored J.Crew Group S-4](https://www.sec.gov/Archives/edgar/data/1520669/000119312511170909/ds4.htm), whose registrant is J.Crew Group, Inc., and replaces its corporate-research note with the documented Broadway identity. No capitalization is guessed.

## Scope exclusions

| Record | Reason |
| --- | --- |
| `now-you-see-me-live` | Broadway.com explicitly identifies the Broadway engagement as part of an ongoing global tour. Excluded from this non-tour sweep. [Source](https://www.broadway.com/buzz/207653/abracadabra-now-you-see-me-live-set-for-broadway-this-holiday-season/) |

The tour exclusion documents the research scope; no designation is edited by this plan. Rocky Horror remains in scope because the current IBDB credits establish commercial involvement despite its nonprofit origin. Fela! remains documented separately because the card explicitly names its 2012 return engagement.

## Reproducible SEC search record

All searches use the public EFTS API, Form D only, with an identified project User-Agent. Counts are the returned total, including unrelated businesses. API error responses were not treated as zero hits. Some requests returned transient SEC backend DNS errors; successful retries are listed below. The four positive issuer histories and all seven candidate XML documents were retrieved directly. No paid proxy or LLM was used for this research.

| Search key | Query and date window | Returned filings |
| --- | --- | --- |
| `10-things` | [10 Things I Hate About You](https://efts.sec.gov/LATEST/search-index?q=%2210+Things+I+Hate+About+You%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `860-janice` | [Janice Crystal](https://efts.sec.gov/LATEST/search-index?q=%22Janice+Crystal%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `860-producer-retry` | [Billy Crystal](https://efts.sec.gov/LATEST/search-index?q=%22Billy+Crystal%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `amish-exact` | [The Amish Project](https://efts.sec.gov/LATEST/search-index?q=%22The+Amish+Project%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `angels` | [Angels + Broadway](https://efts.sec.gov/LATEST/search-index?q=%22Angels%22+%22Broadway%22&forms=D&dateRange=custom&startdt=2017-01-01&enddt=2019-12-31), 2017-01-01 to 2019-12-31 | 3 |
| `beaches-producer-retry` | [Maloney + Prezioso](https://efts.sec.gov/LATEST/search-index?q=%22Maloney%22+%22Prezioso%22&forms=D&dateRange=custom&startdt=2024-01-01&enddt=2026-10-28), 2024-01-01 to 2026-10-28 | 0 |
| `beaches-title` | [Beaches](https://efts.sec.gov/LATEST/search-index?q=%22Beaches%22&forms=D&dateRange=custom&startdt=2024-01-01&enddt=2026-10-28), 2024-01-01 to 2026-10-28 | 0 |
| `blue-man` | [Blue Man](https://efts.sec.gov/LATEST/search-index?q=%22Blue+Man%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `cat-roof-retry` | [Cat on a Hot Tin Roof](https://efts.sec.gov/LATEST/search-index?q=%22Cat+on+a+Hot+Tin+Roof%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `downstate` | [Downstate](https://efts.sec.gov/LATEST/search-index?q=%22Downstate%22&forms=D&dateRange=custom&startdt=2024-01-01&enddt=2026-10-28), 2024-01-01 to 2026-10-28 | 2 |
| `dreamgirls-title` | [Dreamgirls](https://efts.sec.gov/LATEST/search-index?q=%22Dreamgirls%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `fela-exact` | [Fela](https://efts.sec.gov/LATEST/search-index?q=%22Fela%22&forms=D&dateRange=custom&startdt=2009-01-01&enddt=2013-12-31), 2009-01-01 to 2013-12-31 | 1 |
| `fela-hendel` | [Stephen Hendel](https://efts.sec.gov/LATEST/search-index?q=%22Stephen+Hendel%22&forms=D&dateRange=custom&startdt=2011-01-01&enddt=2013-12-31), 2011-01-01 to 2013-12-31 | 0 |
| `fela-title` | [Fela](https://efts.sec.gov/LATEST/search-index?q=%22Fela%22&forms=D&dateRange=custom&startdt=2011-01-01&enddt=2013-12-31), 2011-01-01 to 2013-12-31 | 0 |
| `fish-title` | [Fish in the Dark](https://efts.sec.gov/LATEST/search-index?q=%22Fish+in+the+Dark%22&forms=D&dateRange=custom&startdt=2014-01-01&enddt=2016-12-31), 2014-01-01 to 2016-12-31 | 0 |
| `good-times` | [Let the Good Times Roll](https://efts.sec.gov/LATEST/search-index?q=%22Let+the+Good+Times+Roll%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `living-love` | [Living on Love](https://efts.sec.gov/LATEST/search-index?q=%22Living+on+Love%22&forms=D&dateRange=custom&startdt=2014-01-01&enddt=2016-12-31), 2014-01-01 to 2016-12-31 | 0 |
| `living-producer-final` | [Nugent](https://efts.sec.gov/LATEST/search-index?q=%22Nugent%22&forms=D&dateRange=custom&startdt=2014-01-01&enddt=2015-12-31), 2014-01-01 to 2015-12-31 | 76 |
| `lyons-exact` | [The Lyons](https://efts.sec.gov/LATEST/search-index?q=%22The+Lyons%22&forms=D&dateRange=custom&startdt=2011-01-01&enddt=2013-12-31), 2011-01-01 to 2013-12-31 | 0 |
| `lyons-gm` | [Niko](https://efts.sec.gov/LATEST/search-index?q=%22Niko%22&forms=D&dateRange=custom&startdt=2011-01-01&enddt=2013-12-31), 2011-01-01 to 2013-12-31 | 3 |
| `lyons-producer` | [Kathleen K. Johnson](https://efts.sec.gov/LATEST/search-index?q=%22Kathleen+K.+Johnson%22&forms=D&dateRange=custom&startdt=2011-01-01&enddt=2013-12-31), 2011-01-01 to 2013-12-31 | 0 |
| `present` | [Present Laughter](https://efts.sec.gov/LATEST/search-index?q=%22Present+Laughter%22&forms=D&dateRange=custom&startdt=2016-01-01&enddt=2018-12-31), 2016-01-01 to 2018-12-31 | 0 |
| `present-producer` | [Jordan Roth](https://efts.sec.gov/LATEST/search-index?q=%22Jordan+Roth%22&forms=D&dateRange=custom&startdt=2016-01-01&enddt=2017-07-31), 2016-01-01 to 2017-07-31 | 1 |
| `private-lives-retry` | [Private Lives](https://efts.sec.gov/LATEST/search-index?q=%22Private+Lives%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `rocky-title` | [Rocky Horror](https://efts.sec.gov/LATEST/search-index?q=%22Rocky+Horror%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `rudin-2015` | [Rudin](https://efts.sec.gov/LATEST/search-index?q=%22Rudin%22&forms=D&dateRange=custom&startdt=2014-01-01&enddt=2015-06-30), 2014-01-01 to 2015-06-30 | 23 |
| `rudin-2026` | [Rudin](https://efts.sec.gov/LATEST/search-index?q=%22Rudin%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 15 |
| `small-mouth` | [Small Mouth Sounds](https://efts.sec.gov/LATEST/search-index?q=%22Small+Mouth+Sounds%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `sunset-producer` | [Michael Linnit](https://efts.sec.gov/LATEST/search-index?q=%22Michael+Linnit%22&forms=D&dateRange=custom&startdt=2016-01-01&enddt=2018-12-31), 2016-01-01 to 2018-12-31 | 0 |
| `sunset-producer-grade` | [Michael Grade](https://efts.sec.gov/LATEST/search-index?q=%22Michael+Grade%22&forms=D&dateRange=custom&startdt=2016-01-01&enddt=2018-12-31), 2016-01-01 to 2018-12-31 | 0 |
| `sunset-specific` | [Sunset Boulevard](https://efts.sec.gov/LATEST/search-index?q=%22Sunset+Boulevard%22&forms=D&dateRange=custom&startdt=2016-01-01&enddt=2018-12-31), 2016-01-01 to 2018-12-31 | 21 |
| `three-days` | [Three Days of Rain](https://efts.sec.gov/LATEST/search-index?q=%22Three+Days+of+Rain%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `wanted-retry` | [Wanted + theatrical](https://efts.sec.gov/LATEST/search-index?q=%22Wanted%22+%22theatrical%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |
| `warriors-retry` | [Warriors + Broadway](https://efts.sec.gov/LATEST/search-index?q=%22Warriors%22+%22Broadway%22&forms=D&dateRange=custom&startdt=2025-01-01&enddt=2026-10-28), 2025-01-01 to 2026-10-28 | 0 |

Additional source checks: [Frobisher XML](https://www.sec.gov/Archives/edgar/data/1692119/000169211916000001/primary_doc.xml), [Sons of Leo XML](https://www.sec.gov/Archives/edgar/data/1623723/000114420414063708/primary_doc.xml), [NYA Fund D XML](https://www.sec.gov/Archives/edgar/data/1736261/000173626118000001/primary_doc.xml). None was accepted as a verified show match. The Visit cast-recording issuer was excluded because it finances the recording, not the Broadway production.

## Validation and operational impact

Before changes: `node --test tests/unit/pending-fix-plans.test.mjs` passed 10/10. The real-data inventory found 27 missing amounts across the 44 scoped rows. An in-memory replay through the real `applyDataEdit` writer and `commercialRecordErrors`/`commercialRecordWarnings` with `priorRecord` verifies the proposed after state: four amounts added, nine records touched, no changes to the other records. No private-file apply was run.

Generator preflight: `bro-5530: 25/25 applied cleanly`; `bro-5530-b: 2/2 applied cleanly`. `node --test --test-timeout 300000 tests/unit/pending-fix-plans.test.mjs` passed 10/10 after generation. Real-data replay printed: `REAL DATA REPLAY PASS: 27 actions; 9 changed records; 4 added capitalizations; 27 -> 23 null amounts in 44 scoped rows; 0 record errors/warnings; all other records unchanged.` The replay also asserted `sold` for the two fully sold offerings and `maximum` for the two ceilings, and confirmed that the parsed commercial.json stayed identical to its untouched input.

Writer/caller evidence: `scripts/execute-approved-fix.js:354` calls `applyDataEdit`; `scripts/lib/data-edit-action.js:151` delegates commercial writes to `applyCommercialFieldEdit`. That existing writer stamps the record and derives the capitalization basis. The existing updater already prefers `capitalizedAmount` at `scripts/update-commercial-data.js:2343`; no extraction or reader logic needed changing. The executor consumes `data/pending-fixes/<issueNumber>.json`, and its existing workflow is `.github/workflows/execute-approved-fix.yml`. No script, function, workflow, test, cron or API integration is added. `.gitignore` adds only exact-path exceptions for the two plans and this report, so the runner's existing `git add -A` can collect them. Staging from this sandbox was refused because the shared Git index is read-only; no staging, commit or push was needed to leave these files collectible. Production cost change per run: zero paid fetches, zero LLM calls, zero API calls. One-off direct SEC research: 60 search requests, four issuer-history requests and seven XML requests (71 total); browser research was also read-only.

Main-history check: `git log -S bro-5530 --oneline -5 -- data/pending-fixes` returned no matching plan history. `git log -S capitalizedAmount --oneline -5 -- scripts/lib/sec-edgar-scraper.js` reached the shallow-history boundary at `3a641109`; the current parser already supports explicit capitalized amounts and needed no change. This checkout is shallow, so those searches do not establish the full earlier history. `git diff origin/main -- tests/unit/pending-fix-plans.test.mjs scripts/lib/pending-fix-plan-checks.js` was empty; the supplied fresh-main acceptance result is also PASS.

`GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh "$PWD/.tmp-bro-5530-gauntlet"` passed with `lint-workflows: all gates green`, exit 0 in 225 seconds. The log was inspected; actionlint was unavailable, which the task explicitly permits. Temporary research, fixture and gauntlet directories were removed.

The pending plans await the runner's normal private-data application after landing. The acceptance command `node --test tests/unit/pending-fix-plans.test.mjs` also passed 10/10 after plan generation. The relevant ignore-rule checks, run with `node --test --test-timeout 300000 tests/unit/pending-fix-plans.test.mjs tests/unit/audit-log-gitignore.test.mjs scripts/tests/tracked-and-ignored-guard.test.mjs`, passed 27/27. A Git visibility probe confirmed that all three public artifacts are collectible while commercial.json and shows.json remain ignored. Null amounts with documented no-figure reasons satisfy the card's alternative acceptance criterion. No owner decision or live scraping is required for the proposed changes.
