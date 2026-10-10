# Show inclusion policy

What counts as a show on Broadway Scorecard, and what discovery refuses at
ingest. Written for the 2026 data audit (BRO-4204, sprint 4: S4-T6, S4-T8,
S4-T14) after ~95 non-theatre listings — rugby at Twickenham, arena concerts,
fairground rides, cabaret nights, student showcases, UK tour stops — were found
sitting in `shows.json` as Off-Broadway or Off-West End rows. This page states
the rule the code now enforces; the code is the source of truth and every rule
below names the function that applies it.

## The rule

**Admit** a listing when it is a staged production at a theatre venue:

- plays, musicals, opera and dance-theatre, in any of the four categories
  (`broadway`, `off-broadway`, `west-end`, `off-west-end`);
- anything TodayTix tags with the top-level category **Plays** or **Musicals**,
  even at a venue that would otherwise be refused (a musical booked into Radio
  City or Carnegie Hall is still a musical) — NYC paths only, see below;
- opera at an opera house (Met, ENO at the Coliseum) under the existing opera
  policy — `type: 'opera'` rows are never flagged.

**Reject at ingest**:

| What | Where it is enforced |
|---|---|
| Stadiums, arenas, concert halls, cabaret rooms and one-off attraction sites (Carnegie Hall, Radio City Music Hall, Madison Square Garden, Barclays Center, Beacon Theatre, The Town Hall, 54 Below, Feinstein's, Joe's Pub, Birdland, Café Carlyle, Bowery Ballroom; Twickenham Stadium, Wembley Stadium/Arena, The O2, OVO Arena, Royal Albert Hall, Barbican Hall, Royal Festival Hall / Queen Elizabeth Hall, Cadogan Hall, Union Chapel, Alexandra Palace, Eventim Apollo, Crystal Palace, King's Place, Battersea Power Station; generic `stadium`, `arena`, `concert hall`, `music hall`, `jazz club`, `cabaret`, `comedy club`, `racecourse`) — **unless TodayTix tags the row Plays or Musicals** (NYC paths). London paths reject these outright. | `NON_THEATRE_VENUE_RE` / `isNonTheatreVenue()` in `scripts/lib/venue-classification.js`; applied by `isNonTheaterContent()` gate 3 in `scripts/discover-new-shows.js` (`market: 'london'` = no override) and directly on the OLT and LondonTheatre.co.uk paths |
| TodayTix top-level categories **Concerts, Landmarks, Films, Conversations** (not **Events**: on the NYC feed it also carries NYU Skirball's reviewed international theatre, and anything that gets or might get reviewed stays in) | `NON_THEATRE_TODAYTIX_CATEGORIES`, `isNonTheaterContent()` gate 1b |
| Festival, panel, screening, Q&A, prize-night, comedy-preview, work-in-progress and "NT Live" titles | `NON_THEATRE_TITLE_RE` in `scripts/discover-new-shows.js`, alongside the older `NON_THEATER_PATTERNS` substrings (galas, benefits, readings, orchestras…) |
| One-night bookings (`startDate === endDate`), and listings with no run dates at all (TodayTix's literal `"null"`) **when the venue is a non-theatre venue** — a Carnegie Hall listing with no dates is one concert, not an unannounced run | `isOneNightShow()`; the `"null"` case fires only at a `NON_THEATRE_VENUE_RE` venue so card #1446's fix (real productions listed before they go on sale) stands |
| UK tour stops at Greater London receiving houses (Hackney Empire, New Wimbledon Theatre, Richmond Theatre, Churchill Theatre Bromley, Fairfield Halls, New Victoria Theatre Woking) in the London categories | `LONDON_RECEIVING_HOUSE_RE` / `isLondonReceivingHouse()`; `isNonTheaterContent()` gate 3b and the OLT / LondonTheatre.co.uk paths |
| Theatres outside New York that TodayTix lists in its NYC feed | `NON_NYC_VENUE_RE` (BRO-3211, pre-existing) |

## The safety valve

The gates above apply to **discovery** only — `scripts/discover-new-shows.js`
and the sources it reads (TodayTix NYC and London, Playbill schedules, OLT,
LondonTheatre.co.uk, venue pages, ShowScore candidates). The aggregator
promoters (`scripts/promote-*-candidates.js`) do not consult
`NON_THEATRE_VENUE_RE` or any other gate here, on purpose: anything a
registered outlet reviews, or an aggregator roundup lists, is admitted by the
promoters regardless of venue or category. That is how Les Misérables: The
Arena Concert Spectacular (Radio City, 9 reviews), Dog Man — The Musical (Queen
Elizabeth Hall, 10 reviews) and Silver Manhattan (Bowery Ballroom, 3 reviews)
stay in and stay scored while Harry Connick Jr. at Carnegie Hall does not get
in. A production critics review is a production.

The one promoter that is **not** an aggregator promoter is
`scripts/promote-owe-venue-candidates.js` (S4-T11): it admits rows from the
Off-West End venue-page staging file, and a venue's own what's-on listing is
not review evidence, so it applies the same ingest gates as discovery
(`isNonTheatreVenue()`, `isLondonReceivingHouse()`, `isNonTheaterContent()`
with `market: 'london'`, the venue-page title exclusions) before confirming a
candidate against the live venue page.

## Rows already in the file

The owner's decision for the audit (rule D3): keep a row if it has any review,
is opera, or is at a theatre venue; remove the rest. `scripts/validate-data.js`
now prints a **WARN** (never an error) for each row whose venue matches
`NON_THEATRE_VENUE_RE` and that has no review in `reviews.json`, is not
`type: 'opera'`, and is not a SOLT West End house or an official Broadway house
(`isUnreviewedNonTheatreRow()` in `scripts/lib/venue-classification.js`). The
warning is the cleanup list; it does not block a push.

Rows removed under D3 that sit at real theatres — the Juilliard showcases at
Peter Jay Sharp Theater, Peppa Pig at Theatre Royal Haymarket, the Kiln's
festival and NT Live screenings — are outside what a venue regex can see. New
ones are refused by the title and category gates; the ones already in the file
are handled by the audit's removal list, not by this warning.

## Worked examples

Forty real rows from the audit, twenty admitted and twenty refused, live in
`tests/fixtures/inclusion-policy/examples.json` and are asserted against the
real `isNonTheaterContent()` by `tests/unit/inclusion-policy.test.mjs`. The
venue regex, the theatre-house exemption, the `"null"`-dates rule and the
receiving-house list are covered by `tests/unit/non-theatre-venue.test.mjs`.

| Listing | Decision | Why |
|---|---|---|
| Innocence — Metropolitan Opera House, TodayTix "Opera" | admit | opera at an opera house |
| 11 to Midnight — Orpheum Theatre, "Dance" | admit | dance-theatre at a theatre |
| Now You See Me Live — London Coliseum, "Circus and Magic" | admit | theatre venue, staged production |
| Harry Connick Jr. — Carnegie Hall, "Concerts" | reject | concert hall, category Concerts |
| Betty Buckley: Random Notes — Joe's Pub, "Concerts" | reject | cabaret room, category Concerts |
| Gabby's Dollhouse Live! — Eventim Apollo, "Plays" | reject | London arena; no Plays override on London paths |
| Sylvia — Royal Albert Hall, "Musicals" | reject | London concert hall; no Musicals override on London paths |
| Barbarians v Wales Double Header — Twickenham Stadium | reject | stadium |
| Migrant Qa Panel — New Diorama Theatre | reject | panel / Q&A title |
| The Karate Kid — The Musical — New Wimbledon Theatre, "Musicals" | reject | receiving-house tour stop |

## Changing the rule

- A new stadium, arena, concert hall or cabaret room: add it to
  `NON_THEATRE_VENUE_RE` with a comment naming the row that prompted it, and
  check the "deliberately NOT matched" list above the regex — every bare token
  there (`park`, `wembley`, `apollo`, `barbican`, `arena` next to "Stage") once
  hit a real theatre.
- A new junk-title shape: `NON_THEATRE_TITLE_RE` (word-anchored), not a bare
  substring in `NON_THEATER_PATTERNS`; run it against every title in
  `shows.json` first — the audit's tokens each hit only the audit's junk rows.
- Never route the promoters through these gates. The valve is the design.
