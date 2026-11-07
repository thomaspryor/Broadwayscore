# BRO-5804 missing-week findings

Investigated on 2026-11-05. Two dark weeks are resolved in code. Two playing
weeks still require private-history backfills, so the card is not complete.
The passing regression test does not mean those backfills have been applied.

| Production | Week ending | Finding | Resolution |
| --- | --- | --- | --- |
| the-music-man-2022 | 2022-08-21 | Scheduled hiatus, zero performances | Cited exception in `scripts/lib/alltime-attribution.js` |
| the-music-man-2022 | 2022-09-11 | Scheduled hiatus, zero performances | Cited exception in `scripts/lib/alltime-attribution.js` |
| my-fair-lady-2018 | 2018-03-25 | Eight previews; League row exists on BroadwayWorld | Backfill still required |
| sunset-boulevard-2017 | 2017-04-02 | Seven performances; League row exists on BroadwayWorld | Backfill still required |

## Sources and writer trace

Broadway News explicitly reports no Music Man performances for the weeks ending
[August 21](https://www.broadwaynews.com/broadway-box-office-feels-the-weight-of-three-fewer-shows/)
and [September 11](https://www.broadwaynews.com/despite-some-bright-spots-broadway-box-office-tumbles-after-holiday-weekend/).
This is positive evidence of a hiatus, independent of missing table rows.

The existing writer, `scripts/backfill-grosses-history.ts`, calls `fetchPage`,
`parsePlaybillGrossesHtml`, `findMatchingSlug`, and `toHistoryEntry` before saving
the weekly snapshot. Direct `fetchPage(..., { directOnly: true })` probes and
the real parser returned the requested weeks, no validation errors, and
20/19/32/37 rows respectively for the four dates above. None included its
target show. No target rows were parked in `_unplacedRows` or filed under
another same-title slug. The two playing weeks are source omissions, not
title-matching or parser failures.

BroadwayWorld attributes its tables to the Broadway League. Read the dated
row's HTML attributes and visible cells, including the preview count:

| Field | [My Fair Lady, 2018](https://www.broadwayworld.com/grosses/MY-FAIR-LADY?year=2018) | [Sunset Boulevard, 2017](https://www.broadwayworld.com/grosses/SUNSET-BOULEVARD?year=2017) |
| --- | ---: | ---: |
| Week ending | 2018-03-25 | 2017-04-02 |
| gross | 934717 | 1206660 |
| attendance | 7797 | 9427 |
| performances, including previews | 8 | 7 |
| seatsOffered | 8552 | 11753 |
| capacity | 91.17 | 80.21 |
| atp | 119.88 | 128 |

My Fair Lady prints zero regular performances plus eight previews. Persisting
only its `data-perform="0"` attribute would lose the preview performances.
No figures were inferred from URLs or neighbouring weeks.

The worker's allowed pending-fix actions cannot target `grosses-history.json`;
`data-edit` covers show/commercial fields. No unsupported plan was created and
no private data was written. An authorized data-repair run must add the two
rows above and refresh all-time attribution. Re-running the Playbill backfill
alone will still omit them.

## Verification

- Before: `node --test tests/unit/missing-weeks-audit.test.mjs` failed because
  the file was absent, also confirmed by `git ls-tree origin/main`.
- Current attribution matched `origin/main` before editing. Historical
  `git log -S 'SHOW_DARK_WEEKS' --oneline -5` could not finish because the
  partial clone needed missing objects and its shared object directory was
  read-only. This limits historical verification, not the real-data reproduction.
- Calling `ownRunTotals` before and after on all 5,920 shows changed exactly
  one result: Music Man went from two gaps to complete, with the same
  $160,184,182.31, 373 performances, 614,458 attendees and 54 stored weeks.
  `fillClearedFromHistory` can now fill that total through its existing caller.
- My Fair Lady and Sunset Boulevard still have one gap each on disk.
  Take Me Out remains at 19 gaps. The exceptions do not suppress these holes.
- Supplying just the two published rows to an in-memory copy of real history
  makes both runs complete: My Fair Lady $69,783,820.52 over 69 weeks, Sunset
  Boulevard $23,831,696.20 over 21 weeks. This was a simulation, not a backfill.
- The regression test imports the real attribution functions and covers both
  hiatuses, remaining backfill requirements, unrelated holes, production
  scoping, observed date boundaries, zero rows, malformed rows and Monday keys.
- `node --test tests/unit/missing-weeks-audit.test.mjs`: 10 passed.
- `node --test --test-timeout 300000 tests/unit/missing-weeks-audit.test.mjs tests/unit/alltime-attribution.test.mjs tests/unit/audit-grosses-data.test.mjs tests/unit/grosses-history-repair.test.mjs tests/unit/grosses-run-window.test.mjs`:
  50 passed, zero failed.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  all audits passed; the only failing gate was the unavailable `actionlint`
  executable (`command not found`, exit 127), explicitly exempted for this
  worker. Read `lint-workflows.log` and its recorded exit status, not just
  the gauntlet wrapper's exit code.
- `git diff --check`: passed. No TypeScript files changed.

The existing `scrape-alltime.ts` caller invokes `applyAllTimeAttribution`, which
invokes `fillClearedFromHistory` and `ownRunTotals`. Existing Tuesday/Wednesday
and monthly jobs already run that caller. Added paid fetches, LLM calls and
API calls per run: zero. Investigation used direct public fetches and web
research; no new cron or fetching path was added.
