# NYC show facts audit, two-model pilot and full run (BRO-6489)

Status: pilot done 2026-10-29; full run done 2026-10-29 (1,082 of 1,085 rows checked, owner raised the cap to $100). Full-run results and corrections are in the section "Full run" below; the pilot sections are kept as they were.

## What was checked

Cohort `nyc-facts` in the sourced fact-check harness (`scripts/fact-check-historical-sample.js`, cohort impl in `scripts/lib/nyc-facts-audit.js`). Population: NYC Broadway and Off-Broadway rows that opened on or after 2021-06-01, plus every current or upcoming row (1,085 rows). Four strata, sampled equally (10 each, seed 6489):

| Stratum | Population | What it is |
|---|---|---|
| current-upcoming | 330 | open, previews or announced, any category |
| ob-backfilled | 270 | closed OB rows tagged `historical` (the backfill) |
| ob-recent | 316 | other closed OB rows |
| bway-recent | 169 | closed Broadway rows |

Two checkers answer from the web without seeing the stored values: Gemini 2.5 Flash with Google grounding, and gpt-5-mini with OpenAI web search. Fields: theatre (house and stage), tier (Broadway / Off-Broadway / Off-Off), first preview, opening night, closing (including extensions), type, revival vs new, other NYC runs (transfers, moves, earlier runs). Every field where a checker disagreed with the store, or agreed only without a source, was adjudicated by hand from a fetched page. The adjudications are in `data/audit/fact-check/nyc-facts-adjudications.json` (33 entries, each with the URL used). Model confidence counted for nothing.

## Pilot error rates (40 shows)

Pooled across strata (wrong / checked; "unverifiable" means no page settled it):

| Field | Wrong | Rate | 95% CI | Unverifiable |
|---|---|---|---|---|
| theatre | 0/36 | 0.0% | 0.0-9.6% | 4 |
| tier | 0/36 | 0.0% | 0.0-9.6% | 4 |
| first preview | 3/30 | 10.0% | 3.5-25.6% | 4 |
| opening night | 4/31 | 12.9% | 5.1-28.9% | 4 |
| closing | 2/34 | 5.9% | 1.6-19.1% | 4 |
| type | 1/35 | 2.9% | 0.5-14.5% | 4 |
| revival | 1/36 | 2.8% | 0.5-14.2% | 4 |
| other runs | 1/29 | 3.4% | 0.6-17.2% | 11 |

Where the errors sit:

| Stratum | Errors |
|---|---|
| ob-recent | opening 3/9 (33%), preview 1/6, revival 1/8 |
| ob-backfilled | closing 2/8 (25%), type 1/9 |
| current-upcoming | preview 1/7, opening 1/4, other runs 1/7 |
| bway-recent | preview 1/8 |

Venue and tier were right on every checked row. The date fields carry most of the error, concentrated in Off-Broadway rows.

The Morbs' stored first performance and opening (both Oct 27) were from the July announcement. TDF and BroadwayWorld's Oct 22 extension article give a first preview on Oct 26, an opening on Nov 2 and a closing on Nov 21 after an extension from Nov 14. The stored closing was already right.

## Error classes found

1. **Opening stored equal to first preview.** 137 rows in scope have `openingDate == previewsStartDate` (free consistency check, `nyc-facts-consistency.json`). About 70 are closed OB rows whose opening came from an unconfirmed source. The weekly `enrich-off-broadway-dates.yml` run repairs these only for open rows: closed rows need `--include-closed-when-year-matches`, a flag built for this (Playbill production page year must match the row) and never wired to any workflow mode. Example: Jesa (stored opening Mar 10 = first preview; Public Theater release and Playbill say Mar 20).
2. **Announcement-era dates on venue-page discoveries.** Rows found from a venue page keep the dates of the first announcement, and nothing re-reads them after a schedule change (The Morbs; Three Houses' stored opening was the date of Playbill's opening-night photo article, not the opening).
3. **Missed closing extensions on closed OB rows** (Clowns Like Me, Everything's Fine): the stored closing is the original announced one.
4. **Revival flag missing on an Off-Broadway staging of a work with an earlier NYC production** (Orlando, MCC 2024, after Classic Stage Company 2010). Off-Broadway rows count any earlier New York staging as a revival (Gruesome Playground Injuries and The Brothers Size are stored that way). Broadway rows follow IBDB and count only earlier Broadway productions.
5. **Magic or variety shows typed as play** (Lord Nil).
6. **Earlier run with no row and no `priorRuns` entry** (Hadestown's 2016 New York Theatre Workshop run). Out of this cohort's date scope (before 2021-06-01) and not corrected: a `priorRuns` entry changes which reviews count toward the Broadway score, and the NYTW run is a separate production.

Harness-side classes (the checker, not the data) found and fixed before counting:
- Stage-aware venue compare (`compareNycVenue`): the shared `sameVenue` called "Playwrights Horizons Mainstage" and "Peter Jay Sharp Theater" the same room.
- Off-Off-Broadway tier is a real answer, not a parse failure.
- Type fold covers opera and special (the default fold called opera a musical and had no "special").
- The prompt defines revival so a transfer of the same production counts as new, and it separates a Broadway revival from an Off-Broadway one. Broadway rows count only the first, so an Off-Broadway run before Broadway (Between Riverside and Crazy, Fat Ham) no longer reads as a revival. A code review caught that the pilot adjudication had marked Between Riverside a revival. It was a 2023 Best Play nominee and the first Broadway production, so the stored value stays.
- Revival page support no longer counts an actor's "Broadway debut" as evidence that the work is new, and a magic or variety show described as a comedy folds to special.

All of these are pinned in `scripts/lib/nyc-facts-audit.test.mjs`.

## What was fixed

- **Class 1 (code):** `enrich-off-broadway-dates.yml` gains two dispatch-only modes. `fix-closed` adds `--include-closed-when-year-matches`. `backfill-closed` also bypasses the stability guard, for one reviewed drain. The crons stay on `fix-unconfirmed`, because the stability guard (20 changes or 15%) aborts the whole run rather than capping it. A cron carrying the backlog would abort weekly and block live-show fixes too. A local full-catalog dry run (`--dry-run --fix-unconfirmed --include-closed-when-year-matches`, 597 closed rows in the pool) found a Playbill production page for 11 of 79 same-date rows and proposed 12 changes: 7 corrected openings on closed rows (Chinese Republicans, Marcel on the Train, Jesa, How My Grandparents Fell in Love, Data, Heartbreak Hotel; Bughouse's first preview), 2 openings filled on upcoming rows, and 3 same-date rows confirmed as having no preview period. That is under the guard's limit of 20, so one `fix-closed` dispatch drains it with the guard left on. The other 68 same-date rows have no Playbill production page and stay as they are. Jesa is in both lists, so the plan below goes first. Its correction is then a human one, which the enricher skips, and the plan's expected old value still matches.
- **Rows (data):** pending-fix plan `data/pending-fixes/bro-6489.json`, 12 edits on 8 rows, applied through `execute-approved-fix.yml`: Between Riverside and Crazy (first preview), The Morbs (first preview, opening, status), Lord Nil (type), Clowns Like Me and Everything's Fine (closing), Three Houses, Jesa and Orlando (opening; Orlando also first preview and revival). Jesa and Orlando match their Playbill production pages. Three Houses was corrected from a Playbill article. The Morbs has no Playbill production page yet (world premiere in previews), so the source is TDF plus BroadwayWorld's extension article.

## Full run (1,082 rows)

Same checkers and prompt as the pilot, every row in the cohort. Hand adjudication of every disagreement was not possible at this size, so disagreements were settled by two automatic adjudicators (`adjudicate-playbill` in `scripts/fact-check-historical-sample.js`, rules in `scripts/lib/nyc-facts-audit.js`):

- **playbill-auto:** the row's Playbill production page, read by `scripts/validate-show-venue.js`. Only these verdicts drive row corrections. Guards (tested): the page's venue must match and its year must be one the row belongs to (id suffix or stored dates); a date more than 60 days from the stored one is another engagement, not a fix; a field a person already corrected (`humanCorrected*Date`, or a manual / human-correction / hand-verified source) is never overridden; a closing still to come on a closed row is skipped. The first version lacked these, and a review caught it marking Grey House's hand-corrected opening wrong and Triumph's closing as a future date. The venue validator's ledger keeps only provisional rows, so the run used `--all --show=<ids>` with `VENUE_AUDIT_PATH` pointing at a scratch file to keep results for any row.
- **pages-auto:** both checkers agree with each other against the store and cite a fetched page. Counted in the error table, never used to correct a row. Guards (tested): theatre, tier and other-runs are never auto-wrong, and a date is auto-wrong only when the two answers sit within 31 days of the stored date. The first pages-auto pass marked rows wrong where both checkers had found a different production of the same title (a revival a decade later); the guards were added before counting.

648 field verdicts are still pending (no Playbill page and no agreeing sourced pair). They count in neither column, so the rates below are rates among settled fields.

| Field | Wrong / checked | Rate | 95% CI | Unverifiable |
|---|---|---|---|---|
| theatre | 0/893 | 0.0% | 0.0-0.4% | 183 |
| tier | 0/1004 | 0.0% | 0.0-0.4% | 78 |
| first preview | 6/769 | 0.8% | 0.4-1.7% | 116 |
| opening night | 25/693 | 3.6% | 2.5-5.3% | 204 |
| closing | 7/843 | 0.8% | 0.4-1.7% | 139 |
| type | 28/959 | 2.9% | 2.0-4.2% | 114 |
| revival | 17/896 | 1.9% | 1.2-3.0% | 186 |
| other runs | 1/790 | 0.1% | 0.0-0.7% | 292 |

By stratum, the errors concentrate in closed Off-Broadway rows outside the backfill: ob-recent opening night 20/163 (12.3%), first preview 5/175 (2.9%), closing 5/255 (2.0%). The backfilled OB rows' dates are clean (opening 1/232) but their type is wrong in 11/233 (4.7%). Closed Broadway rows had no settled date errors (0/150 first previews, 0/155 openings). The pilot's date rates (10-13%) were from 40 rows, mostly the worst stratum; the full run's pooled rates are lower and the ob-recent opening rate matches the pilot.

New error classes from the full run:

7. **Type guessed as play when unknown.** NYC show builders default an unknown type to play, so Off-Broadway musicals and solo cabaret shows land as plays (The Seat of Our Pants, Bear Grease, Saturday Church). Code fix filed as BRO-6506; rows corrected below.
8. **Off-Broadway revival flags missing** on stagings of works with earlier New York productions (Sea Wall, Elektra, The Receptionist, Coriolanus). Same convention as pilot class 4.
9. **Announcement-era dates** (pilot class 2) recur on closed OB rows beyond the venue-page discoveries: a stored opening a week or more before the real one.

Corrections: two pending-fix plans, `data/pending-fixes/bro-6489-playbill-1.json` (25 edits, 21 rows) and `bro-6489-playbill-2.json` (12 edits, 9 rows), written by `plan-playbill` and applied through `execute-approved-fix.yml`. Every edit is a playbill-auto "wrong" verdict with the Playbill value as the new value and the stored value as the expected old value. The guards above leave out Mrs. Doubtfire (2020 pre-shutdown previews vs the 2021 restart), Going Bacharach (return engagement), Othello (Bedlam) and Music City (over 60 days), Grey House (hand-corrected) and Triumph (closing still to come). Held by hand with `--hold`: four rows whose id names a year other than their dates (Animal Wisdom, Bad Kreyòl, Jerome, Caroline), Shit. Meet. Fan. (first preview 50 days off), and Cat Cohen: Broad Strokes (cabaret, which this site files as special; Playbill says musical).

Full-run cost: about $84.72 at list price; with the pilot, about $88 total, under the $100 cap.


### Second correction pass (authoritative pages)

The 84 pooled wrong verdicts break down per field as follows: fixed by the Playbill plans / fixed by authoritative-page plans / stored value right on recheck / already fixed / still open.

| Field | Wrong | Playbill plans | Authoritative plans | Right on recheck | Already fixed | Open |
|---|---|---|---|---|---|---|
| first preview | 6 | 3 | 2 | 1 | 0 | 0 |
| opening night | 25 | 18 | 4 | 1 | 0 | 2 |
| type | 28 | 6 | 18 | 1 | 0 | 3 |
| revival | 17 | 6 | 9 | 1 | 1 | 0 |
| closing | 7 | 4 | 2 | 0 | 0 | 1 |
| other runs | 1 | 0 | 0 | 0 | 1 | 0 |

The verdicts judged wrong only from non-Playbill pages (pages-auto) and the six held rows were re-verified one by one on a Playbill production page, IBDB, or the theatre or producer's own page, and corrected through `bro-6489-auth-1.json` and `bro-6489-auth-1-b.json` (36 edits, including the Slanted Floors closing extension found on the way). On recheck the stored value was right for Macbeth (type), Gloria (revival), Pretend It's Pretend (first preview) and Animal Wisdom (opening). Six stay open because no authoritative page could be read or none names the field: Peter Panto, Pizza (Nature Theater of Oklahoma) and The Unsinkable (type), Isla and The Gin Game (opening), El Quijote (closing). Guard-skipped verdicts are nulled before counting, so they are not in the 84.

A rerun found that a data-edit whose value another fix had already written was refused and turned the run red. `applyDataEdit` now treats it as a no-op success (`noop: true`): shows.json edits still run their validators against the stored value and still apply the human pins and revival tags, and `execute-approved-fix.js` leaves no-ops out of the applied count, so no repeat reader email goes out.

## Cost

Pilot: $0.67 model fees plus $2.57 search fees at list price = $3.24 for 40 shows, about $0.081 a show. A full run over 1,085 rows would cost about $88; it was run after the owner raised the cap (see Full run). A field-targeted rerun is cheaper. Re-checking only the three date fields on the 586 closed OB rows would cost about $25-30, but the free consistency checks plus the closed-row enrich mode already reach most of class 1.

## Reproduce

```
node scripts/fact-check-historical-sample.js sample --cohort=nyc-facts --n=40 --seed=6489
node scripts/fact-check-historical-sample.js check  --cohort=nyc-facts --max-usd=6
node scripts/fact-check-historical-sample.js report --cohort=nyc-facts
# full run: check every row, then settle disagreements from Playbill and agreeing sourced pages
node scripts/fact-check-historical-sample.js adjudicate-playbill --cohort=nyc-facts --results=<validate-show-venue result files> --pages --dry-run
node scripts/fact-check-historical-sample.js plan-playbill --cohort=nyc-facts --prefix=bro-6489-playbill --hold=shit-meet-fan-off-broadway-2024,animal-wisdom-off-broadway-2022,bad-krey-l-off-broadway-2026,jerome-off-broadway-2025,caroline-off-broadway-2026,cat-cohen-broad-strokes-off-broadway-2026 --dry-run
```
