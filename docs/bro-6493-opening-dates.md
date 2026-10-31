# BRO-6493: closed off-Broadway date research

Partial resolution, researched 2026-10-29. No private data was written. Three pending plans contain 56 data-edit actions for 37 closed off-Broadway rows: 18 date corrections and 19 source confirmations. All actions are replayed with the real executor helper before delivery. Each plan has at most 25 actions.

## Scope and baseline

- The committed consistency snapshot has 137 same-date findings. The current runner snapshot has 126, including 97 closed off-Broadway rows. Jesa is already corrected to March 20, 2026 and is left alone.
- The retained closed-mode enrichment run (2026-10-29T06:49:39.218Z) records 53 same-date URL misses, rather than a recoverable list of the card's original 68. Of those 53, 51 are currently closed: five already have distinct dates, 36 are addressed by these plans, and 10 remain held below. Two are no longer closed. Scorched Earth, whose page failed title/year validation, is the additional planned row.
- The wider current consistency class also contains later historical imports and recent discoveries. The remaining wider rows are inventoried below; source labels on them are not claimed as fresh confirmations.

## Projected effect on the real data

`applyDataEdit()` from `scripts/lib/data-edit-action.js` was used to replay every generated action on an in-memory copy of the runner snapshot. `consistencyFindings()` from `scripts/lib/nyc-facts-audit.js` counted the class before and after. Private JSON and review-texts were never modified.

```json
{
  "actions": 56,
  "changedRecords": 37,
  "correctedRecords": 18,
  "confirmedRecords": 19,
  "before": 126,
  "projectedAfter": 108,
  "unrelatedRecordsChanged": 0
}
```

Public Charge: opening 2026-03-12 -> 2026-03-25, preview unchanged. Bughouse: preview 2026-03-11 -> 2026-02-24, opening unchanged. Romeo & Juliet Suite: both dates stay 2026-03-02, source changes from ibdb to venue-page:park-avenue-armory:no-previews.

Confirmed same-day rows deliberately remain in the consistency class. For touring concerts, dance and premiere engagements, confirmation means the sourced local premiere/opening coincides with the first advertised public performance. It does not assert that there were no rehearsals. A run window alone was not used to invent a later opening date.

## Sources and decisions

All dates below are read from page content, never from URL metadata. The row title, venue, year and engagement were checked. News articles and producer announcements provide the second source where production-page discovery failed. Indexed Playbill production-page content was available even when a subsequent direct request returned 403; confirmations also cite contemporary reporting. No new automatic fallback was added.

| Row | Decision | Source evidence |
| --- | --- | --- |
| Spread (spread-off-broadway-2026) | previewsStartDate: 2026-03-02 -> 2026-02-21; source: venue-page:intar | INTAR identifies February 21 previews and March 2 opening for the 2026 production. [Source](https://www.intartheatre.org/now-playing) |
| Public Charge (public-charge-off-broadway-2026) | openingDate: 2026-03-12 -> 2026-03-25; source: playbill | Newman Theater production starts March 12 and officially opens March 25, 2026. [Source](https://playbill.com/article/see-whos-starring-in-public-charge-by-former-u-s-ambassador-julissa-reynoso-at-the-public) |
| Cold War Choir Practice (cold-war-choir-practice-off-broadway-2026) | openingDate: 2026-02-21 -> 2026-03-10; source: broadwayworld | MCC production explicitly opened March 10, 2026. March 9 producer celebration is distinct from official opening. [Source](https://www.broadwayworld.com/shows/Cold-War-Choir-Practice-335723.html) [Corroboration](https://www.broadwayworld.com/off-broadway/article/Alana-Raquel-Bowers-Will-Cobbs-and-More-to-Star-in-COLD-WAR-CHOIR-PRACTICE-at-MCC-Theater-20251030) |
| Bughouse (bughouse-off-broadway-2026) | previewsStartDate: 2026-03-11 -> 2026-02-24; source: playbill | Vineyard production began previews February 24; opening remains March 11, 2026. [Source](https://playbill.com/article/world-premiere-of-bughouse-extends-off-broadway) |
| Meat Suit, or the s**tshow of motherhood (meat-suit-or-the-stshow-of-motherhood-off-broadway-2026) | openingDate: 2026-02-11 -> 2026-02-25; source: playbill | Irene Diamond Stage production previews February 11 before February 25, 2026 official opening. [Source](https://playbill.com/article/aya-ogawas-meat-suit-begins-off-broadway-february-11) |
| Body Count (body-count-off-broadway-2026) | openingDate: 2026-03-03 -> 2026-03-05; source: broadwayworld | SoHo US premiere runs March 3 to 29, 2026, with March 5 opening. [Source](https://www.broadwayworld.com/off-broadway/article/Edinburgh-Fringe-Hit-BODY-COUNT-Makes-US-Premiere-At-SoHo-Playhouse-in-March-20260213) |
| How My Grandparents Fell in Love, A Musical (how-my-grandparents-fell-in-love-a-musical-off-broadway-2026) | openingDate: 2026-03-17 -> 2026-03-22; source: playbill-production-page | 59E59 Theater B page distinguishes March 17 preview and March 22, 2026 opening. [Source](https://playbill.com/production/how-my-grandparents-fell-in-love-a-musical-off-broadway-59e59-theater-b-2026) |
| Maltby & Shire's ABOUT TIME (maltby-and-shires-about-time-off-broadway-2026) | previewsStartDate: 2026-03-15 -> 2026-02-27; source: playbill-production-page | Marjorie S. Deane page lists February 27 previews and March 15, 2026 opening. [Source](https://playbill.com/production/about-time-off-broadway-marjorie-s-deane-little-theater-the-west-side-y-2026) |
| Zack (zack-off-broadway-2026) | previewsStartDate: 2026-03-08 -> 2026-02-21; source: playbill-production-page | Mint at Theatre Four: February 21 first preview and March 8, 2026 opening. [Source](https://playbill.com/production/zack-off-broadway-theatre-row-theatre-2026) |
| Nicole Travolta is Doing Alright (nicole-travolta-is-doing-alright-off-broadway-2026) | openingDate: 2026-04-01 -> 2026-04-05; source: playbill | SoHo encore starts April 1 with April 5, 2026 official opening. [Source](https://playbill.com/article/nicole-travolta-is-doing-alright-to-play-encore-run-at-soho-playhouse) |
| Silver Manhattan (silver-manhattan-off-broadway-2026) | openingDate: 2026-02-18 -> 2026-03-04; source: tdf | Jesse Malin listing separates February 18 previews from March 4, 2026 opening; venue discrepancy requires separate research. [Source](https://www.tdf.org/shows/23044/silver-manhattan/) |
| Trash (trash-off-broadway-2026) | openingDate: 2026-03-07 -> 2026-03-13; source: broadwayworld | PAC NYC production starts March 7 and opens March 13, 2026. [Source](https://www.broadwayworld.com/off-broadway/article/Full-Cast-and-Creative-Team-Set-for-TRASH-at-PAC-NYC-20260212) |
| Romeo & Juliet Suite (romeo-and-juliet-suite-off-broadway-2026) | Keep 2026-03-02; confirm opening equals first public performance; source: venue-page:park-avenue-armory:no-previews | Armory dates the official opening March 2, 2026; performance schedule starts that day, following February 28 dress rehearsal. [Source](https://www.armoryonpark.org/blog/2026/spring-2026-youth-corps-recap/) [Corroboration](https://www.armoryonpark.org/season-events/2026-season/romeo-juliet-suite/) |
| An Ark (an-ark-off-broadway-2026) | openingDate: 2026-01-09 -> 2026-01-21; source: broadwayworld | Retrospective extension announcement distinguishes January 9 start and January 21, 2026 official opening; supersedes collapsed Playbill production dates. [Source](https://www.broadwayworld.com/off-broadway/article/AN-ARK-Starring-Ian-McKellen-Golda-Rosheuvel-and-More-Extends-at-The-Shed-20260217) |
| Scorched Earth (scorched-earth-off-broadway-2026) | openingDate: 2026-04-03 -> 2026-04-07; source: nystagereview | Contemporary reviewer explicitly dates St. Ann's US opening April 7, 2026; April 3 was the run start. [Source](https://nystagereview.com/2026/04/12/scorched-earth-a-dance-theater-police-procedural/) |
| The Amazing Sex Life of Rabbits (the-amazing-sex-life-of-rabbits-off-broadway-2026) | openingDate: 2026-03-02 -> 2026-03-03; source: broadwayworld | March 4 production coverage states SoHo premiere officially opened March 3, 2026; TDF series schedule starts March 2. [Source](https://www.broadwayworld.com/shows/The-Amazing-Sex-Life-of-Rabbits-335874.html) [Corroboration](https://www.tdf.org/shows/22998/the-international-fringe-encore-series-2026/) |
| Innocence (innocence-off-broadway-2026) | Keep 2026-04-06; confirm opening equals first public performance; source: venue-page:metropolitan-opera:no-previews | Official Met performance archive records the company premiere April 6, 2026, matching the first public performance. [Source](https://archives.metopera.org/MetOperaSearch/record.jsp?dockey=0387948) [Corroboration](https://www.metopera.org/about/press-releases/the-metropolitan-opera-presents-the-company-premiere-of-kaija-saariahos-innocence-on-april-6/) |
| El Último Sueño de Frida y Diego (el-ultimo-sueno-de-frida-y-diego-off-broadway-2026) | Keep 2026-05-14; confirm opening equals first public performance; source: venue-page:metropolitan-opera:no-previews | Dated May 14, 2026 official performance program identifies the Metropolitan Opera premiere, matching the first performance. [Source](https://www.metopera.org/globalassets/season/2025-26/el-ultimo-sueno-de-frida-y-diego/programs/051426-frida-y-diego.pdf) |
| Tristan und Isolde (tristan-und-isolde-off-broadway-2026) | Keep 2026-03-09; confirm opening equals first public performance; source: official-production:yuval-sharon:no-previews | Director's official production page lists seven performances starting March 9, 2026; Met's indexed program labels it the new-production premiere. [Source](https://www.yuvalsharon.com/schedule/tristan-metro-opera) [Corroboration](https://www.metopera.org/globalassets/season/2025-26/tristan-und-isolde/programs/030926-tristan-isolde.pdf) |
| La ternura (la-ternura-off-broadway-2025) | openingDate: 2025-05-29 -> 2025-05-30; source: broadwayworld | Repertorio announcement body explicitly separates May 29 preview and May 30, 2025 opening; ignore conflicting generic subheading. [Source](https://www.broadwayworld.com/off-broadway/article/alfredo-sanzols-la-ternura-to-be-presented-at-repertorio-in-may-20250410) |
| The Little Mermaid the Musical (the-little-mermaid-the-musical-off-broadway-2026) | Keep 2026-02-21; confirm opening equals first public performance; source: broadwayworld:no-previews | Cast announcement calls February 21, 2026 the opening; producer's dated Players Theatre schedule also starts February 21. [Source](https://www.broadwayworld.com/off-broadway/article/Literally-Alive-Unveils-Cast-of-THE-LITTLE-MERMAID-THE-MUSICAL-20260204) [Corroboration](https://literallyalive.com/the-little-mermaid/) |
| Eugene Onegin (eugene-onegin-off-broadway-2026) | Keep 2026-04-20; confirm opening equals first public performance; source: venue-page:metropolitan-opera:no-previews | Met press release says the eight-performance revival opens April 20, 2026, matching the first performance. [Source](https://v16live.metopera.org/about/press-releases/soprano-asmik-grigorian-returns--in-her-met-role-debut-as-tatiana-in-tchaikovskys-eugene-onegin-on-april-20/) |
| Milo Rau & Édouard Louis: The Interrogation (milo-rau-and-edouard-louis-the-interrogation-off-broadway-2026) | Keep 2026-03-26; confirm opening equals first public performance; source: venue-page:nyu-skirball:no-previews | Venue lists North American premiere March 26 to 28, 2026, all at 7:30; TheaterMania explicitly confirms March 26 opening. [Source](https://nyuskirball.org/performance/the-interrogation/) [Corroboration](https://www.theatermania.com/shows/new-york-city-theater/milo-rau-edouard-louis-the-interrogation_1815049/) |
| A.I.M by Kyle Abraham: Cassette Vol. 1 (aim-by-kyle-abraham-cassette-vol-1-off-broadway-2026) | Keep 2026-04-16; confirm opening equals first public performance; source: venue-page:nyu-skirball:no-previews | Venue labels the April 16 to 18, 2026 engagement its NYC premiere; opening coincides with first advertised public performance. [Source](https://nyuskirball.org/performance/cassette-vol-1/) [Corroboration](https://www.tdf.org/shows/22967/a-i-m-by-kyle-abraham-cassette-vol-1/) |
| Robyn Orlin: We wear our wheels with pride (robyn-orlin-we-wear-our-wheels-with-pride-off-broadway-2026) | Keep 2026-03-13; confirm opening equals first public performance; source: venue-page:nyu-skirball:no-previews | Venue's North American premiere runs March 13 to 14, 2026; TDF explicitly identifies March 13 opening. [Source](https://nyuskirball.org/performance/we-wear-our-wheels-with-pride/) [Corroboration](https://www.tdf.org/shows/22963/we-wear-our-wheels-with-pride/) |
| Manual Cinema: The 4th Witch (manual-cinema-the-4th-witch-off-broadway-2026) | Keep 2026-10-15; confirm opening equals first public performance; source: venue-page:nyu-skirball:no-previews | Venue lists the NYC premiere October 15 to 17, 2026, with opening coinciding with first advertised public performance. [Source](https://nyuskirball.org/performance/the-4th-witch/) |
| Olga Pericet: Baile Sonoro (olga-pericet-baile-sonoro-off-broadway-2026) | Keep 2026-05-22; confirm opening equals first public performance; source: broadwayworld:no-previews | Repertorio production announcement explicitly opens the nine-performance engagement May 22, 2026, matching its first performance. [Source](https://www.broadwayworld.com/off-broadway/article/Photos-Flamenco-Artist-Olga-Pericet-to-Present-BAILE-SONORO-at-Repertorio-Espaol-NYC-20260512) |
| Hugo Marchand | Artists at the Center (hugo-marchand-artists-at-the-center-off-broadway-2026) | Keep 2026-07-23; confirm opening equals first public performance; source: venue-page:new-york-city-center:no-previews | Venue schedules four performances July 23 to 26, 2026; contemporary interview explicitly dates opening July 23. [Source](https://www.nycitycenter.org/events/2026-2027-hugo-marchand-artists-at-the-center) [Corroboration](https://pointemagazine.com/hugo-marchand-new-york-city-center/) |
| Entangled: 12 Scenes in a Circle K off the I-40 in New Mexico (entangled-12-scenes-in-a-circle-k-off-the-i40-in-new-mexico-off-broadway-2026) | openingDate: 2026-03-11 -> 2026-03-12; source: broadwayworld | Opening-night coverage explicitly dates HERE world premiere March 12, 2026; earlier announcement starts performances March 11. [Source](https://www.broadwayworld.com/off-broadway/article/Photos-SOCIETY-Theatre-Company-Debuts-ENTANGLED-at-HERE-Arts-Center-20260316) [Corroboration](https://www.broadwayworld.com/off-broadway/article/society-theatre-company-to-debut-entangled-at-here-arts-center-this-march-20260202) |
| Lost in Del Valle (lost-in-del-valle-off-broadway-2026) | previewsStartDate: 2026-04-09 -> 2026-02-23; openingDate: 2026-04-09 -> 2026-04-11; source: producer-press-release | April 6 producer release headline updates opening to April 11; April 28 producer news repeats April 11. Both preserve February 23 previews; earlier April 9 body is stale. [Source](https://talkinbroadway.com/allthatchat_new/d.php?id=2645128) [Corroboration](https://www.broadwayworld.com/off-broadway/article/Kenny-Leon-Joins-LOST-IN-DEL-VALLE-Talkback-With-Amir-Arison-20260428) |
| Jamire Williams (jamire-williams-off-broadway-2026) | Keep 2026-03-25; confirm opening equals first public performance; source: venue-page:park-avenue-armory:no-previews | Venue identifies a two-date solo percussion concert March 25 to 26, 2026 in the Veterans Room; first concert is the local opening. [Source](https://www.armoryonpark.org/season-events/2026-season/artists-studio/jamire-williams/) |
| The Listening (the-listening-off-broadway-2026) | Keep 2026-04-07; confirm opening equals first public performance; source: official-production:aks-immersive:no-previews | Producer advertises world premiere April 7 to 12, 2026 only; TDF explicitly confirms April 7 opening. [Source](https://experiences.aks-tickets.com/THE-LISTENING-HOME/) [Corroboration](https://www.tdf.org/shows/23116/the-listening/) |
| Puppet Up! (puppet-up-off-broadway-2026) | Keep 2026-10-02; confirm opening equals first public performance; source: venue-page:tribeca-performing-arts-center:no-previews | Venue advertises the October 2, 2026 touring comedy performance; TheaterMania confirms October 2 opening and October 3 closing. [Source](https://tribecapac.org/event/brian-hensons-puppet-up/) [Corroboration](https://www.theatermania.com/shows/new-york-city-theater/off-broadway/puppet-up_1850321/) |
| Rosie Revere, Ada Twist, and Iggy Peck (rosie-revere-ada-twist-and-iggy-peck-off-broadway-2026) | Keep 2026-10-17; confirm opening equals first public performance; source: venue-page:new-victory:no-previews | Venue dates touring musical October 17 to 25, 2026, with author signing after first performance; TDF confirms October 17 opening. [Source](https://www.newvictory.org/events/2627-live-performance-rosie-revere-ada-twist-and-iggy-peck) [Corroboration](https://www.tdf.org/shows/23576/rosie-revere-ada-twist-and-iggy-peck-the-questioneers/) |
| No Excuses, No Limits (no-excuses-no-limits-off-broadway-2026) | Keep 2026-03-07; confirm opening equals first public performance; source: broadwayworld:no-previews | New York premiere of touring breakdance show starts March 7, 2026; TheaterMania explicitly confirms March 7 opening. [Source](https://www.broadwayworld.com/off-broadway/article/ILL-Abilities-Breakdancing-Troupe-to-Perform-at-New-Victory-Theater-20260210) [Corroboration](https://www.theatermania.com/shows/new-york-city-theater/no-excuses-no-limits_1822672/) |
| La Traviata (la-traviata-off-broadway-2026) | Keep 2026-03-20; confirm opening equals first public performance; source: parterre-box:no-previews | Contemporary eyewitness explicitly dates opening March 20, 2026; Met's indexed dated program labels that performance the season premiere. [Source](https://parterre.com/2026/04/07/cavalcade-of-stars/) [Corroboration](https://www.metopera.org/globalassets/season/2025-26/la-traviata/programs/032026-traviata.pdf) |
| Encores! The Wild Party (encores-the-wild-party-off-broadway-2026) | Keep 2026-03-18; confirm opening equals first public performance; source: playbill-production-page | Indexed production page explicitly lists both first preview and opening March 18, 2026; contemporaneous article confirms the City Center Encores run. [Source](https://playbill.com/production/the-wild-party-off-broadway-new-york-city-center-2026) [Corroboration](https://playbill.com/article/jasmine-amy-rogers-adrienne-warren-more-star-in-encores-the-wild-party-beginning-march-18) |

## Held rows from the recorded URL-miss cohort

These records are unchanged. Their dates require stronger page evidence or adjudication of conflicting sources.

| Row | Stored same date | Reason |
| --- | --- | --- |
| ice-queen-off-broadway-2026 | 2026-03-07 | 92NY curriculum is available, but no production-year opening confirmation was found. |
| the-infinite-wrench-off-broadway-2025 | 2025-04-04 | Sources conflate the continuing show and venue changes; April 4, 2025 at Second City remains unconfirmed. |
| im-almost-there-off-broadway-2026 | 2026-06-09 | BAM member event confirms June 9 start, but does not distinguish an official opening from previews. |
| hold-on-to-your-butts-off-broadway-2026 | 2026-02-07 | TheaterMania labels February 7 opening; BWW lists February 15 opening and February 2 previews, while TDF starts the run February 7. Conflict held. |
| messy-millie-off-broadway-2026 | 2026-05-02 | 92NY curriculum has no dated 2026 opening confirmation. Own-site results excluded as circular evidence. |
| youre-a-good-man-charlie-brown-off-broadway-2026 | 2026-03-14 | TodayTix confirms March 14 start at 92NY, not a distinct opening or no-preview confirmation. |
| touch-off-broadway-2026 | 2026-03-14 | TheaterMania gives March 12, an interview associates March 14 with opening, and the New York Theater calendar gives March 19. Conflict held. |
| sexual-misconduct-of-the-middle-classes-off-broadway-2026 | 2026-03-17 | Audible producer announcement confirms March 17 return start; Playbill gives only March 2026 for opening, with no day. |
| uncensored-no-need-to-overthink-it-off-broadway-2026 | 2026-04-11 | MCC lists six performances beginning April 10, earlier than stored April 11; page does not identify a separate official opening. |
| quarter-rican-off-broadway-2026 | 2026-10-11 | Rights holder confirms Hostos engagement October 11-15; a separate opening or explicit no-preview statement remains unconfirmed. |

Supporting held-row pages: [Hold On to Your Butts](https://www.broadwayworld.com/shows/Hold-Onto-Your-Butts-335831.html), [Touch interview](https://www.out.com/theater/anthony-rapp-touch-rent), [Touch calendar](https://newyorktheater.me/2026/02/27/march-2026-new-york-theater-openings/), [Audible return announcement](https://origin-www.audible.com/about/newsroom/audible-theater-and-together-expand-2026-season-with-two-productions), [MCC youth performance schedule](https://mcctheater.org/tix/uncensored-no-need-to-overthink-it/), [Quarter Rican rights-holder schedule](https://www.theatricalrights.com/show/quarter-rican/).

## Other current closed same-date rows

These are outside the retained URL-miss cohort and were not changed. This inventory prevents interpreting the reduced count as complete acceptance. No existing source label below is being independently endorsed.

| Row | Same date | Existing source |
| --- | --- | --- |
| encores-la-cage-aux-folles-off-broadway-2026 | 2026-06-17 | playbill-production-page |
| pen-pals-off-broadway-2025 | 2025-01-06 | ibdb |
| rheology-off-broadway-2026 | 2026-04-14 | playbill-production-page |
| the-maids-off-broadway-2026 | 2026-05-17 | playbill-production-page |
| cosi-fan-tutte-off-broadway-2026 | 2026-09-23 | (missing) |
| ectoplasm-off-broadway-2026 | 2026-09-24 | previews-fallback |
| red-riding-hood-off-broadway-2026 | 2026-09-26 | previews-fallback |
| september-l-davis-the-apology-tour-off-broadway-2026 | 2026-09-20 | playbill-production-page |
| conflicted-off-broadway-2026 | 2026-09-17 | venue-page:soho-playhouse |
| the-ford-hill-project-off-broadway-2026 | 2026-09-08 | playbill-production-page |
| rabih-mroue-and-lina-majdalanie-four-walls-and-a-roof-off-broadway-2026 | 2026-10-22 | previews-fallback |
| night-of-january-16th-off-broadway-2026 | 2026-10-07 | previews-fallback |
| the-second-best-school-shooting-off-broadway-2026 | 2026-10-17 | first-performance-no-press-night |
| big-feelings-off-broadway-2026 | 2026-09-13 | first-performance-no-press-night |
| beyond-the-stardust-off-broadway-2026 | 2026-09-10 | first-performance-no-press-night |
| alice-in-wonderland-off-broadway-2026 | 2026-09-26 | first-performance-no-press-night |
| burning-leaves-off-broadway-2026 | 2026-09-26 | previews-fallback |
| triumph-off-broadway-2026 | 2026-10-08 | playbill-production-page |
| fishing-for-alaska-off-broadway-2026 | 2026-10-09 | previews-fallback |
| odd-man-out-off-broadway-2024 | 2024-06-27 | playbill-bro-6153 |
| chiaroscuro-off-broadway-2025 | 2025-05-26 | playbill-bro-6153 |
| prince-faggot-off-broadway-2025 | 2025-09-10 | playbill-ob-historical |
| pygmalion-off-broadway-2025 | 2025-10-22 | playbill-ob-historical |
| endgame-off-broadway-2025 | 2025-10-22 | playbill-ob-historical |
| burnout-paradise-off-broadway-2024 | 2024-11-12 | playbill-ob-historical |
| pretty-perfect-lives-off-broadway-2024 | 2024-08-17 | playbill-ob-historical |
| dark-noon-off-broadway-2024 | 2024-06-07 | playbill-ob-historical |
| safe-house-off-broadway-2025 | 2025-02-15 | playbill-ob-historical |
| elephant-and-piggies-we-are-in-a-play-off-broadway-2025 | 2025-02-01 | playbill-ob-historical |
| iluminate-off-broadway-2023 | 2023-11-17 | playbill-ob-historical |
| lone-star-off-broadway-2023 | 2023-11-24 | playbill-ob-historical |
| make-me-gorgeous-off-broadway-2023 | 2023-11-10 | playbill-ob-historical |
| waiting-for-godot-off-broadway-2023 | 2023-11-04 | playbill-ob-historical |
| walk-on-through-confessions-of-a-museum-novice-off-broadway-2023 | 2023-11-13 | playbill-ob-historical |
| bettingers-luggage-off-broadway-2023 | 2023-09-19 | playbill-ob-historical |
| prometheus-firebringer-off-broadway-2023 | 2023-09-15 | playbill-ob-historical |
| sesame-street-the-musical-off-broadway-2023 | 2023-07-29 | playbill-ob-historical |
| hamlet-off-broadway-2024 | 2024-03-19 | playbill-ob-historical |
| macbeth-an-undoing-off-broadway-2024 | 2024-04-05 | playbill-ob-historical |
| public-obscenities-off-broadway-2024 | 2024-01-17 | playbill-ob-historical |
| i-love-you-so-much-i-could-die-off-broadway-2024 | 2024-02-01 | playbill-ob-historical |
| job-off-broadway-2024 | 2024-01-19 | playbill-ob-historical |
| illinoise-off-broadway-2024 | 2024-03-02 | playbill-ob-historical |
| david-blaine-presents-asi-winds-inner-circle-off-broadway-2022 | 2022-09-15 | playbill-ob-historical |
| remember-this-the-lesson-of-jan-karski-off-broadway-2022 | 2022-09-10 | playbill-ob-historical |
| the-goodbye-girl-off-broadway-2023 | 2023-05-07 | playbill-ob-historical |
| the-knight-of-the-burning-pestle-off-broadway-2023 | 2023-04-17 | playbill-ob-historical |
| des-moines-off-broadway-2022 | 2022-12-04 | playbill-ob-historical |
| the-importance-of-being-earnestly-lgbtq-off-broadway-2021 | 2021-07-06 | playbill-ob-historical |
| this-beautiful-future-off-broadway-2022 | 2022-09-10 | playbill-ob-historical |

## Writer, wiring and cost

- `scripts/one-time-backfill-opening-date-source.js:46` groups Broadway and off-Broadway together and labels all existing openings ibdb at line 53. That legacy label is not page evidence. The current enricher at `scripts/enrich-off-broadway-dates.js:1131` handles same-date repairs, and its closed-row eligibility at `scripts/lib/ob-date-fix-eligibility.js` requires a matching production year. The missing production-page route leaves these rows audit-only. The chosen fix is the card-authorized per-row plan route at the private source of truth, not a reader-side suppression.
- `scripts/execute-approved-fix.js:360` calls the actual `applyDataEdit` helper and its line 725 data-edit branch dispatches the plan actions. Opening edits receive the existing human-correction pin before the explicit cited source edit. No new functions, flags, scripts or workflows are delivered.
- No new paid fetches, LLM calls or API calls per run. No cron changes. Research used manual web search and page reads only.

## Verification and delivery

- Reproduction: `node scripts/fact-check-historical-sample.js consistency --list --class=preview-equals-opening` returned 126 same-date findings. The generated shared audit file was restored afterwards.
- History: `git log -S 'include-closed-when-year-matches' --oneline -5 -- scripts/enrich-off-broadway-dates.js` returned `9e3e5ab7`. `git log -S 'BRO-6493' --oneline -5 -- scripts data/pending-fixes` returned no prior fix. `git diff origin/main -- scripts/validate-data.js scripts/lib` was empty, so the local acceptance check uses the same validator and library bytes as origin/main.
- Generation used `node --require ./.tmp-bro-6493/local-data.cjs scripts/new-fix-plan.js --id=bro-6493 --summary="..." --actions=.tmp-bro-6493/actions.json`. The temporary preload selected the runner-provided in-checkout data instead of allowing the CLI to refresh private clones outside this workspace. Generation and preflight succeeded: 25/25, 25/25, 6/6 actions. Its final automatic git-add step failed with `index.lock: Read-only file system`; all three plan files were already written. The exact .gitignore exceptions keep the plans and this report visible to the runner without requiring index writes here.
- `node .tmp-bro-6493/verify.cjs` passed all replay, year, date-order, intended-field and unrelated-record assertions. This temporary verifier requires the real executor and audit functions; it contains no copied business logic. All 56 actions applied cleanly; 37 intended records changed, zero unrelated records changed.
- `node --test --test-timeout 300000 tests/unit/pending-fix-plans.test.mjs scripts/lib/data-edit-action.test.mjs tests/unit/opening-date-guards.test.mjs`: 39 passed, 0 failed.
- Production timeline replay also passed for all 37 rows: no opening after closing, and no earliest performance moved later, so these plans do not newly exclude earlier reviews by advancing a production start.
- `git diff --check` passed. The shared consistency audit was restored byte-for-byte from HEAD after `git checkout --` hit the same read-only index.
- No TypeScript, UI, scoring logic, regex arrays, script tests, package files or workflow files changed.

`node scripts/validate-data.js --strict` was run both before edits and after plan generation. Both runs failed with the same one error and no shows.json writes. Before any edits, it failed on one unrelated private review: `art-west-end-2016/artshub--gina-fairley.json`, dated 2016-01-29, 326 days before the production earliest date 2016-12-20. The card-provided fresh-main pass does not reproduce on this runner snapshot. This record was not edited.

## Remaining work

- Resolve the 10 held URL-miss rows above and reconcile the original 68-row cohort with the retained audit. The wider remaining current rows also need review before claiming every remaining same-date opening has a confirmed source.
- Apply the pending plans through the runner after landing. The count 108 is projected, not a claim that the private data has already changed.
- Resolve the unrelated Art validation failure through its own private-review correction.
- Silver Manhattan date evidence identifies Bowery Palace; the row currently names Bowery Ballroom. Venue was outside this date-only change and remains unresolved.
