# BRO-6098 verification, 2026-11-09

The monitor repairs in this diff are verified locally. Source backfills and the
card's incorrectly named acceptance command remain open.

## What was already on main

Starting checkout: `ebb185ce52f54ef63a82188a77930670437ab5af` (`origin/main`).
The existing monitor suite passed all 15 tests before editing.

The stranded `land/bro-6098-fixups` branch was compared with main through the
GitHub API. Its monitor files already match the starting checkout byte for byte:

| File | Git blob |
| --- | --- |
| `scripts/lib/aggregator-health.js` | `ef25d8a6ebeb64ab07afa9933f2a04a2cd168427` |
| `scripts/audit-aggregator-health.js` | `f8944c2b94712d46fed633358e834f0b04ebe5aa` |

`git log --oneline --grep='BRO-6098' -5` includes `99d27b6d8f8`, the manual-run,
retired-workflow and missing-archive fixes. The requested `git log -S
'aggregator-health' --oneline -5` could not complete: missing historical blobs
trigger a lazy fetch, which cannot write this checkout's read-only shared Git
object directory. File hashes and the existing test run establish the relevant
current-main state independently.

## Source investigation

| Source | Evidence and disposition |
| --- | --- |
| The Stage | Job `120256056777` in run `39905390938` failed at Browserbase's recovery reserve, `200/185`, before scraping. Main already uses sitemap discovery and plain cookie fetching in `scripts/lib/thestage-fetch.js`, wired from `scripts/scrape-thestage-roundups.js`. The latest scheduled success in the snapshot was November 3, 2026. Login renewal still belongs to the cookie-renewal pipeline; no credentials or scraping were changed here. |
| Stagedoor | The workflow and registry explicitly record retirement on June 25, 2026, after the domain redirected to London Theatre Direct. Re-enabling this cron would contradict that documented retirement. No re-enablement or backfill was attempted. |
| LBO | Main already has the BRO-6101 production/venue matching helper and its caller, replacing the hardcoded venue-list failure. Its regression tests pass. This checkout cannot establish which missing historical pages were subsequently backfilled. |
| BWW London | Main's `buildRoundupQuery()` searches the whole domain for London shows, avoiding the old `/article` filter that excluded `/westend/article`. Its query regression tests pass. Historical backfill completeness remains unverified. |
| NYC Theatre / Playbill | A read-only provenance check of 912 review files for Broadway openings in 2025 Q3, 2025 Q4 and 2026 Q1 found the counts below. NYC Theatre's Q4 gap remains visible. Playbill's ingested provenance is higher than the card's old archive percentage. These are different metrics, so neither finding establishes that the original gap was legitimate or fully repaired. |
| West End Theatre | Existing title-matching and extraction tests pass. Without the aggregator archive or a live source census, this checkout cannot distinguish unpublished roundups from missed discovery or validate the historical coverage slide. |

Provenance counts use `source`/`sources` and the actual writers' fields:
`nycTheatreExcerpt` and `playbillVerdictUrl`. They count a show with any such
record, not scored reviews, validated production matches or archived pages.

| Broadway opening quarter | Shows | NYC Theatre provenance | Playbill provenance |
| --- | ---: | ---: | ---: |
| 2025 Q3 | 4 | 4 | 4 |
| 2025 Q4 | 10 | 4 | 8 |
| 2026 Q1 | 4 | 4 | 4 |

Q4 examples: Chess and Marjorie Prime have both sources. Ragtime has NYC Theatre
provenance but no Playbill provenance. All Out has neither. The other Q4 shows
without NYC Theatre provenance are Oedipus, Queen of Versailles, Little Bear
Ridge Road, Liberation and Beetlejuice.

## Root cause, changes and effect

The existing caller is `scripts/audit-aggregator-health.js`, invoked with
`--alert` by the advisory step in `data-health-check.yml`. The CLI loads inputs,
calls `assess()`, then routes or resolves conditions through `owner-alert-router`.
The problems were in that path:

- The registry omitted theatre.reviews, DTLI and Show Score, including three
  distinct scheduled workflows. They are now monitored using their existing
  archive folder names and schedules.
- The API loader read the most recent 30 runs of any event. Enough dispatches
  could hide a stopped schedule. The extracted, tested loader now requests
  `event=schedule`, deduplicates shared workflows and skips retired sources.
- `assess()` returned no finding for a readable empty run list. It now emits
  `workflow-no-runs`; unavailable or malformed responses remain unknown.
- Shared workflow condition keys depended on registry order. They now use the
  lexically first active source, with one finding per workflow.
- Alert resolution used global archive availability. One readable source could
  clear another source's coverage alert despite its folder being absent.
  Resolution now requires that source's archive or that workflow's run history.

Replaying the same 5,926 shows and saved real workflow histories before and
after gives 7 -> 10 report rows and 5 -> 8 monitored active workflows. All seven
existing report rows are unchanged, and current findings remain zero. Examples
of the three added rows: theatre.reviews has two scheduled failures after an
October 19 success; DTLI's weekly workflow succeeded November 8; Show Score's
daily refresh succeeded November 8. None crosses the existing failure/staleness
thresholds on November 9. No show or review records were changed.

Replaying The Stage's real scheduled history with a cutoff of October 24 returns
`status: failing`, `streak: 19`. The existing historical Stagedoor test detects
the June 22 cessation by July 10, before considering the documented retirement.

Cost per scheduled monitor run: 8 GitHub run-history reads instead of 6, a net
increase of 2 (three new workflows, one retired workflow no longer fetched).
Zero new paid scraper requests, LLM calls or workflow dispatches. The existing
daily health-check cron and digest routing remain advisory; no alert was sent
from this worker.

## Verification

- `node --test scripts/audit-aggregator-health.test.mjs`: fails before and after,
  `Could not find 'scripts/audit-aggregator-health.test.mjs'`.
- `node --test --test-timeout 300000 scripts/lib/aggregator-health.test.mjs scripts/lib/aggregator-health-inputs.test.mjs`:
  new regressions first failed (15 passing, 5 failures), then 21 passed.
- `node --test --test-timeout 300000 scripts/lib/thestage-fetch.test.mjs scripts/lib/lbo-roundup-match.test.mjs scripts/lib/bww-roundup-query.test.mjs scripts/lib/wet-roundup-discover.test.mjs`:
  30 passed, 1 archive-dependent test skipped, 0 failed.
- `node scripts/audit-aggregator-health.js --now=2026-11-09` and the same command
  with `--no-runs`: exit 0, 0 findings; coverage explicitly skipped because
  `data/aggregator-archive` is absent.
- `node scripts/audit-test-yml-lib-deps.js`: no gaps.
- `node scripts/audit-toplevel-script-test-yml-coverage.js --json`: `{"gaps":[]}`.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  only failure is `actionlint: command not found` (exit 127), allowed by the
  worker instructions. The remaining workflow audits passed.
- `git diff --check`: passes. No TypeScript, scoring logic, workflow or private
  data files were edited.

## Still required

The requested top-level acceptance-test filename cannot safely be added in this
worker. `scripts/audit-aggregator-health.js` is absent from `test.yml`'s push-path
allow-list. The top-level test coverage audit infers that sibling source even
when a test imports only library functions. Adding the named file would thus
introduce a failing gate, and workflow edits are expressly forbidden here.
Correct the card's command to the two library test files above, or authorize the
workflow allow-list change and a top-level test entry point together.

The source-specific archive census, any still-needed historical backfills, and
the subsequent rebuild require the normal pipeline with writable private
archives/review data. This worker has no aggregator archive and must not write
the provided review-texts clone. NYC Theatre, Playbill and West End Theatre's
remaining publication-versus-discovery questions need that census. None is
reported as complete here.
