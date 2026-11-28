# Id-year drift — per-id root cause (2026 data audit, BRO-4204 S5-T4)

Generated 2026-09-28 against the core-data `shows.json` (3,073 rows) with the
rule now wired into `validate-data.js` (`scripts/lib/id-year-drift.js`):
**a non-closed show whose id ends in a 4-digit year that matches neither its
`openingDate` year nor its `previewsStartDate` year.** 45 rows trip it. The
audit's 22 are the subset that is still `upcoming` and opens *after* the id
year (class A below); `validate-data.js --dry-run` lists all 45 as
`WARNING: Id year drift: …`.

## How the year gets into an id

`scripts/discover-new-shows.js mintCandidateId()` mints `<slug>-<market>-<year>`
once, at discovery, with the year from `productionIdYear()`
(`scripts/lib/todaytix-dates.js`): **opening date → previews date → unconfirmed
start → the current year**. Nothing renames the id when dates arrive later
through enrichment (`enrich-todaytix-data.js`, IBDB, Playbill, Theatremonkey,
venue-page backfills), because the id is the page URL. From this change on, a
row minted on the current-year fallback carries `idYearProvisional: true` so
the WARN (and the S8-T1 rename tool) can tell a fallback year from a deliberate
one. Existing rows predate the stamp; their provenance is inferred below from
the fields the row does carry.

Legend for "minted by": `discoverySource` when the row has one; otherwise the
strongest signal on the row — `todaytixId` present ⇒ the TodayTix listing
discovery (the only path that writes it), `openingDateSource` ⇒ where the date
came from *later*. `discoveredAt` exists only on rows minted after that stamp
was introduced (2026-05).

## Classes

| Class | Pattern | Rows | Why the year is wrong |
|---|---|---|---|
| **A** | `upcoming`/`open`, dates **later** than the id year | 24 (the audit's 22 + `stranger-things-2024`, `my-joy-is-heavy-off-broadway-2025`) | Source listed the title **before any date** (TodayTix "announced" listing, Signature's season page, Playbill's schedule). `productionIdYear()` found nothing and fell back to the discovery year; the real dates arrived months later via enrichment. |
| **B** | long-running `open` rows, dates **earlier** than the id year | 20 | Show was already running when first ingested (the 2021 West End launch batch: `-west-end-2021`; later London/OWE sweeps: `abba-voyage`, `burlesque`, `the-traitors-live-experience`, attractions like `shreks-adventure`/`armory-public-tours`). Same fallback — no date at minting — but the true opening is in the *past*, so the id says "2021/2026" for a 1985/1999/2006 opening. |
| **D** | id year earlier than *everything* | 1 (`wanted-2022`) | A date was present at minting but wrong: the row carries a 2022 id although it was (re-)discovered by `playbill-broadway` on 2026-08-13 with 2026 dates — the id can only have been minted from a 2022-dated listing (TodayTix id 44366 pre-dates the Playbill stamp). Not a fallback case; the provisional stamp would not have caught it. |

`dolly-an-original-musical-2026` (on the audit's list) does **not** trip the
rule: previews start 2026-12-07, opening 2027-01-19, so the id matches the
previews year. A fresh mint today would name it `-2027` (opening wins in
`productionIdYear`), but the WARN rule as specified accepts either date year.
Judgment call recorded here; S8-T1 can still rename it.

## Per-id table

Columns: id · status · category · id year · openingDate · previewsStartDate ·
`discoverySource` · `discoveredAt` · `openingDateSource` · `provisional` ·
minted by (inferred) · why no usable date at minting.

### Class A — announced before dates (the audit's 22 are marked ★)

| id | status | cat | id yr | opening | previews | discoverySource | discoveredAt | openingDateSource | prov. | minted by | why no date at minting |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ★ evita-2026 | upcoming | broadway | 2026 | 2027-03-25 | 2027-02-27 | — | — | playbill | — | TodayTix listing (id 19071) | Announced Jan 2026 for a 2027 Winter Garden run; TodayTix listed it dateless; dates later from Playbill/IBDB. |
| ★ gloria-2026 | upcoming | broadway | 2026 | 2027-04-05 | 2027-03-17 | — | — | ibdb | — | TodayTix listing | Same: dateless announcement, IBDB filled the 2027 dates later. |
| ★ paddington-the-musical-2026 | upcoming | broadway | 2026 | 2027-04-18 | 2027-03-30 | — | — | ibdb | — | TodayTix listing | Same. |
| ★ purple-rain-2026 | upcoming | broadway | 2026 | 2027-04-12 | 2027-03-12 | — | — | ibdb | — | TodayTix listing | Same. |
| ★ 10-things-i-hate-about-you-on-broadway-2024 | upcoming | broadway | 2024 | — | 2027-08-17 | — | — | — | — | TodayTix listing (id 44231) | Listed in 2024 with venue "TBA" and no date; a 2027 previews date landed later, still no opening. |
| ★ wanted-2022 | upcoming | broadway | 2022 | 2026-11-08 | 2026-10-15 | playbill-broadway | 2026-08-13 | playbill | cleared 2026-09-28 | see class D | Date present but wrong at minting (class D). |
| ★ miss-saigon-west-end-2026 | upcoming | west-end | 2026 | 2027-05-27 | 2027-05-13 | — | — | theatremonkey | — | TodayTix London listing | Announced dateless; Theatremonkey supplied the 2027 dates in `enrich-west-end-dates`. |
| ★ august-osage-county-west-end-2026 | upcoming | west-end | 2026 | 2027-01-26 | 2027-01-18 | — | — | theatremonkey | — | West End promoter / Theatremonkey (no todaytixId) | Announcement row without dates; Theatremonkey dated it later. |
| ★ mr-loverman-west-end-2026 | upcoming | west-end | 2026 | 2027-03-04 | 2027-02-25 | — | — | theatremonkey | — | TodayTix London listing | As miss-saigon. |
| ★ samira-west-end-2026 | upcoming | west-end | 2026 | 2027-02-11 | 2027-02-04 | — | — | theatremonkey | — | TodayTix London listing | As miss-saigon (NT Dorfman season announced without dates). |
| ★ the-traitors-acts-of-betrayal-west-end-2026 | upcoming | west-end | 2026 | 2027-06-08 | 2027-05-10 | — | — | theatremonkey | — | TodayTix London listing | As miss-saigon. |
| ★ ivanov-west-end-2026 | upcoming | off-west-end | 2026 | 2027-08-03 | 2027-07-27 | — | — | theatremonkey | — | TodayTix London listing (id 45596) | Bridge Theatre season announced without dates. |
| ★ no-mans-land-west-end-2026 | upcoming | off-west-end | 2026 | 2027-02-23 | 2027-02-13 | — | — | theatremonkey | — | West End promoter / Theatremonkey (no todaytixId) | As august-osage-county. |
| ★ miles-for-mary-off-broadway-2026 | upcoming | off-broadway | 2026 | 2027-02-23 | 2027-02-09 | venue-page:signature-theatre | 2026-05-26 | — | true | venue-listing discovery (Signature season page) | Signature's 2026-27 season page listed titles with no dates on 2026-05-26; dates backfilled from `signaturetheatre.org/productions`. |
| ★ angela-s-mixtape-off-broadway-2026 | upcoming | off-broadway | 2026 | 2027-05-25 | 2027-05-11 | venue-page:signature-theatre | 2026-05-26 | — | true | venue-listing discovery (Signature season page) | Same run as miles-for-mary. |
| ★ too-bad-for-her-off-broadway-2026 | upcoming | off-broadway | 2026 | — | 2027-01-09 | — | — | — | — | TodayTix listing | Dateless listing; a 2027 previews date landed later, still no opening. |
| ★ wild-about-you-off-west-end-2026 | upcoming | off-west-end | 2026 | 2027-01-26 | 2027-01-18 | — | — | theatremonkey | — | TodayTix London listing | As miss-saigon. |
| ★ ripples-off-west-end-2026 | upcoming | off-west-end | 2026 | — | 2027-01-21 | — | — | — | — | TodayTix London listing (id 47215) | Bush Theatre listing without dates; previews date arrived later, no opening yet. |
| ★ insane-asylum-seekers-off-west-end-2026 | upcoming | off-west-end | 2026 | — | 2027-02-12 | — | — | — | — | TodayTix London listing | Same shape as ripples. |
| ★ the-seagull-globe-off-west-end-2026 | upcoming | off-west-end | 2026 | — | 2027-01-15 | — | — | — | — | TodayTix London listing | Same shape as ripples. |
| ★ la-distance-off-west-end-2026 | upcoming | off-west-end | 2026 | — | 2027-01-22 | — | — | — | — | TodayTix London listing | Same shape as ripples. |
| stranger-things-2024 | open | broadway | 2024 | 2025-04-22 | 2025-03-28 | — | — | ibdb | — | TodayTix listing | Announced 2024 for a 2025 Marquis opening; dateless at minting. Already open — rename is cosmetic. |
| my-joy-is-heavy-off-broadway-2025 | open | off-broadway | 2025 | 2026-03-17 | 2026-02-25 | — | — | playbill-production-page | — | TodayTix listing | Listed in 2025 without dates; Playbill production page dated it in 2026. |

### Class B — discovered after opening (long-runners; not on the audit's list)

| id | status | cat | id yr | opening | previews | openingDateSource | minted by | why the year is wrong |
|---|---|---|---|---|---|---|---|---|
| harry-potter-2021 | open | broadway | 2021 | 2018-04-22 | 2018-03-16 | ibdb | 2021 catalogue import | Ingested in 2021 while running; IBDB later supplied the 2018 opening. |
| hamilton-west-end-2021 | open | west-end | 2021 | 2017-12-21 | — | unknown | 2021 West End launch batch | Batch minted every running London show as `-west-end-2021`; opening filled later. |
| the-play-that-goes-wrong-west-end-2021 | open | west-end | 2021 | 2014-09-18 | — | unknown | 2021 West End launch batch | Same. |
| magic-mike-live-west-end-2021 | open | off-west-end | 2021 | 2018-11-28 | 2018-11-28 | manual (wftp sweep 2026-05-01) | 2021 West End launch batch | Same; a manual sweep corrected a COVID-reopening date to the 2018 launch. |
| the-book-of-mormon-west-end-2024 | open | west-end | 2024 | 2013-03-21 | — | unknown | 2024 London sweep | Running since 2013; row minted in 2024. |
| the-lion-king-west-end-2021 | open | west-end | 2021 | 1999-10-19 | — | unknown | 2021 West End launch batch | Same as hamilton-west-end. |
| mamma-mia-west-end-2021 | open | west-end | 2021 | 1999-04-06 | — | unknown | 2021 West End launch batch | Same. |
| les-miserables-west-end-2021 | open | west-end | 2021 | 1985-12-04 | 1985-10-08 | unknown | 2021 West End launch batch | Same. |
| matilda-the-musical-west-end-2021 | open | west-end | 2021 | 2011-11-24 | — | unknown | 2021 West End launch batch | Same. |
| the-mousetrap-west-end-2021 | open | west-end | 2021 | 1952-11-25 | — | unknown | 2021 West End launch batch | Same. |
| showstopper-the-improvised-musical-west-end-2023 | open | west-end | 2023 | 2015-09-01 | — | unknown | 2023 London sweep | Same shape. |
| six-the-musical-west-end-2021 | open | west-end | 2021 | 2019-01-16 | — | unknown | 2021 West End launch batch | Same. |
| wicked-west-end-2021 | open | west-end | 2021 | 2006-09-27 | — | unknown | 2021 West End launch batch | Same. |
| witness-for-the-prosecution-west-end-2022 | open | off-west-end | 2022 | 2017-10-23 | 2017-10-23 | manual (Stuart King email 2026-04-27) | 2022 London sweep | Same; date supplied by hand in 2026. |
| operation-mincemeat-west-end-2024 | open | west-end | 2024 | 2023-05-09 | 2023-03-29 | theatremonkey | 2024 London sweep (no todaytixId) | Transfer already open when ingested. |
| burlesque-west-end-2026 | open | off-west-end | 2026 | 2025-07-22 | 2025-07-10 | theatremonkey | TodayTix London listing | Discovered in 2026, opened July 2025. |
| 58th-street-off-west-end-2026 | previews | off-west-end | 2026 | — | 2025-07-31 | — | TodayTix London listing | Dateless at minting; a 2025 previews date arrived later (status never advanced — see S7-T7). |
| abba-voyage-off-west-end-2026 | open | off-west-end | 2026 | 2022-05-28 | 2022-05-27 | inferred-from-reviews | TodayTix London listing | Attraction running since 2022; discovered 2026. |
| the-magicians-table-off-west-end-2026 | open | off-west-end | 2026 | — | 2025-01-08 | — | TodayTix London listing | Same shape as 58th-street. |
| the-traitors-live-experience-off-west-end-2026 | open | off-west-end | 2026 | 2025-08-02 | 2025-07-01 | manual-verified-official-launch | TodayTix London listing | Attraction; opened 2025, discovered 2026. Candidate for the D3 non-theatre removal. |
| shreks-adventure-london-standard-entry-off-west-end-2026 | previews | off-west-end | 2026 | — | 2021-05-31 | — | TodayTix London listing | Attraction (D3 non-theatre candidate); a 2021 "previews" date is the venue's reopening. |
| armory-public-tours-off-broadway-2026 | previews | off-broadway | 2026 | — | 2024-01-06 | — | TodayTix listing | Not a production (D3 non-theatre candidate). |

## What changed in code (this task)

- `mintCandidateId()` returns `idYearProvisional` and the accepted row is
  stamped `idYearProvisional: true` only when the current-year fallback was
  used (`scripts/discover-new-shows.js`).
- `validate-data.js` WARNs on every row above via `checkIdYearDrift()`
  (`scripts/lib/id-year-drift.js`; unit test `tests/unit/id-year-drift.test.mjs`).
- Renaming stays a deliberate, tooled step: S8-T1 (`rename-show-id.js` +
  redirects), one id per land run, class A first.
