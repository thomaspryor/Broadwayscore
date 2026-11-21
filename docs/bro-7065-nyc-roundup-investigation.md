# BRO-7065: NYC Theatre archive coverage

Investigated November 13, 2026. Partial fix only; the alert acceptance still fails.

## Evidence and root cause

Read the live private repository directory at
`thomaspryor/broadway-review-texts/aggregator-archive/nyc-theatre` through the
GitHub connection: 169 HTML files. Resolve both production IDs and legacy slugs
using the real `data/shows.json`, as `audit-aggregator-health.js` does.
`coverageSeries()` and `coverageVerdict()` report 49% recent versus 78% baseline,
flagged, for the card's same quarters. The baseline differs from the original
82% alert; this is a later archive/core-data snapshot. The 24 target productions
have 12 missing archives. Eleven of those are closed and excluded by the current
batch discovery filter. A closed-show exclusion proves why a missing archive
cannot recover in batch mode, not why it originally went missing.

The live [Lost Boys roundup](https://www.newyorkcitytheatre.com/news/reviews/558202)
has `NewsArticle.datePublished` of April 27, 2026. Its subtitle mentions the
1987 source film. Before the fix, the real `validatePageMatchesShow()` returned
`valid: false`, reason `year mismatch: heading years [1987] vs show opened 2026`.
The separate archive category check passed. Thus a valid, discoverable page
was rejected before the archive writer at `scrape-nyc-theatre-roundups.js:587`.
This reproduces one concrete cause of missing coverage, not all twelve gaps.

The validator now permits this subtitle-year exception only when the subtitle
dates source material (film, movie, novel or book), the title and h1 contain
no years, and strict publication metadata dates the article to the
opening year. Strict mode accepts page-level OpenGraph publication metadata or
article JSON-LD matching the canonical page. Related articles, modification
dates, product schema, body dates and URL-derived dates cannot rescue it.
Other callers of the date extractor keep their existing default behavior.

## Missing archives

The source searches below were performed on November 13. No result is not proof
that a publisher never published a roundup. The other 12 productions in these
quarters have archives, including legacy `chess.html` and `marjorie-prime.html`.

| Production ID | Quarter | Current batch eligibility | Source or matching evidence |
| --- | --- | --- | --- |
| the-lost-boys-2026 | 2026Q2 | Eligible | Published roundup; reproduced subtitle-year rejection; fixed |
| proof-2026 | 2026Q2 | Excluded: closed | [Published roundup](https://www.newyorkcitytheatre.com/news/reviews/557347); current title and category checks pass; historical disappearance unproven |
| joe-turners-come-and-gone-2026 | 2026Q2 | Excluded: closed | No roundup located in source-specific search |
| beaches-2026 | 2026Q2 | Excluded: closed | Source show listing found, no roundup located |
| the-fear-of-13-2026 | 2026Q2 | Excluded: closed | Source show listing found, no roundup located |
| celebrity-autobiography-2026 | 2026Q2 | Excluded: closed | No roundup located in source-specific search |
| all-out-2025 | 2025Q4 | Excluded: closed | No roundup located in source-specific search |
| oedipus-2025 | 2025Q4 | Excluded: closed | No roundup located in source-specific search |
| queen-versailles-2025 | 2025Q4 | Excluded: closed | Source show listing found, no roundup located |
| little-bear-ridge-road-2025 | 2025Q4 | Excluded: closed | No roundup located in source-specific search |
| liberation-2025 | 2025Q4 | Excluded: closed | Search found other shows' roundups, not this production |
| ragtime-2025 | 2025Q4 | Excluded: closed | Source news index found, no roundup located |

## Verification

- Real HTML replay with `validatePageMatchesShow(html, show.title,
  {openingYear: 2026, skipLlm: true})`: **1 of 3 decisions changes**.
  Lost Boys: reject to accept, confidence 1. Proof: remains accepted, confidence
  0.6 without an LLM. Rocky Horror: remains accepted, confidence 1. The first
  two HTML pages were retrieved through `fetchPage()`; Rocky Horror came from
  the private archive. No review or archive data was written to a private repo.
- The same replay using `git show origin/main:scripts/lib/page-validator.js`
  reproduces the Lost Boys rejection on main. Pickaxe history searches could
  not finish because lazy-fetching missing Git objects attempted to write the
  read-only parent `.git/objects/pack` directory.
- `node --test --test-timeout 300000 tests/unit/page-validator-subtitle-year.test.mjs`:
  first run failed the two positive regression cases; final suite passes all
  16 cases. Tests require the real library, not a copied implementation.
- `node --test --test-timeout 300000 $(rg -l 'article-extractor|page-validator' tests scripts --glob '*.test.*')`:
  625 passed, 0 failed. This includes every discovered test that references the
  two modified modules.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  finished with only `actionlint` failing, exit 127, because the binary is not
  installed. All other audit gates passed. Read `lint-workflows.log` to verify
  the failure list, rather than treating the overall exit as a pass.
- Independent code review caught and verified the fix for related-article date
  fallback. Final review found no code blockers. External-model API review was
  unavailable because neither OpenAI nor Gemini credentials were present.
- Existing wiring: `scrape-nyc-theatre-roundups.js:505,567` calls the validator
  for cached and fetched pages. `.github/workflows/scrape-new-aggregators.yml:618`
  runs that scraper on its daily schedule. `page-validator.js` calls the new
  strict extractor mode; no new script or workflow is needed.
- `node scripts/audit-aggregator-health.js --no-runs`: exits 0 but explicitly
  skips coverage because the local full archive checkout is absent. This is
  not evidence of resolution. The live filename-list calculation above uses
  the monitor's real coverage functions, not invented archive files.
- `node scripts/audit-aggregator-health.js`: exits 0, reports two unrelated
  BroadwayWorld workflow-staleness findings and skips local archive coverage.
- `node scripts/check-alert-condition-absent.js --key-b64 YWdncmVnYXRvci1oZWFsdGg6bnljLXRoZWF0cmU6Y292ZXJhZ2UtZHJvcA`:
  FAIL, condition still open, last fired `2026-11-13T10:00:19.243Z`.

## Cost and remaining work

No new paid fetch, SERP, or API operation is introduced. Publication validation
is local parsing. A newly accepted borderline heading can reach the existing
LLM tiebreaker, at most Gemini then OpenAI per such page; Lost Boys matches at
confidence 1 and adds zero LLM calls. The existing scraper runs daily.
Investigation fetches used free Playwright; no paid scraper credentials were
available. No batch eligibility expansion was made.

Backfill Lost Boys and Proof through the existing targeted scraper in an
environment authorized to write the private archives and review files. Investigate
source availability and historical failures for the other ten missing productions.
Then run the full health monitor with archive data and let its normal alert path
resolve the condition if coverage has recovered. Do not manually resolve the
ledger or treat this partial code fix as completion of BRO-7065.
