# NYC show facts audit, two-model pilot (BRO-6489)

Status: pilot done 2026-10-29. Full run not done: it would cost about $88 against a $30 cap (see Cost).

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

## Cost

Pilot: $0.67 model fees plus $2.57 search fees at list price = $3.24 for 40 shows, about $0.081 a show. A full run over 1,085 rows would cost about $88, so it was not run. A field-targeted rerun is cheaper. Re-checking only the three date fields on the 586 closed OB rows would cost about $25-30, but the free consistency checks plus the closed-row enrich mode already reach most of class 1.

## Reproduce

```
node scripts/fact-check-historical-sample.js sample --cohort=nyc-facts --n=40 --seed=6489
node scripts/fact-check-historical-sample.js check  --cohort=nyc-facts --max-usd=6
node scripts/fact-check-historical-sample.js report --cohort=nyc-facts
```
