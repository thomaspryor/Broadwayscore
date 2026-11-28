# BRO-3344 production verification, 2026-10-26

## Breaker evidence instrumentation, 2026-10-27

The analyzer, report and five-test acceptance check already exist on main.
`git log -S 'serp-volume-post-fix' --oneline -5` returns the shallow checkpoint
`0284019f`; the acceptance test file is identical to `origin/main` and passes.
This follow-up leaves that implementation intact and addresses the missing
correlation in the production writer instead.

The current real ledger contains 109,049 records. None of its 70,174 SD organic,
3,134 BD or 344 SD image rows has a run identifier or breaker snapshot. The new
writer fields apply prospectively; they cannot reconstruct historical trips.

`provider-telemetry.js` now adds a random process-scoped `run_id` and increasing
`run_seq` to existing `serp.*` rows, including SB fallbacks. `url-discovery.js`
supplies `breaker` on actual SD organic/image and BD API/unlocker outcomes:

- `consecutive_failures`: the actual counter after the outcome.
- `opened_at`: the current cooldown timestamp in milliseconds, or null.
- `threshold` and `cooldown_ms`: the configured trip and cooldown limits.
- `probe`: whether the request's dispatcher admitted it after cooldown.

Group by `run_id` and host, then sort by `run_seq`, not file order. The two BD
functions share one counter; SD organic and images have independent counters.
A sequence reaching five failures followed by a successful `probe:true` row
with zero failures provides evidence of recovery in that process. Check the
intervening rows and timing too. An incomplete or rotated run cannot establish
the full sequence. Rows from older code lack these fields and remain unknown.

SD starts its cooldown on the next blocked call, so its fifth failure can have
`opened_at:null`. Both BD subpaths can carry `probe:true` from the same
dispatcher admission. BD `short_html` failures do not increment the current
breaker counter. These are existing behaviors, preserved in the diagnostics.
Concurrent requests can overlap; completion sequence is not request-start
sequence, and a probe marker does not assert exclusive probe admission.

Existing callers, including `opening-night-poller.js` and
`rediscover-review-urls.js`, already use `url-discovery.js`; its telemetry
delegates through `bd-telemetry.js` to `recordProviderCall()`. No new entry point,
cron, provider request or paid/LLM/API call is introduced. Existing scheduled
consumers emit the additional fields with their normal calls. There are no
extra event rows or changes to routing, credits, retries or breaker state.
The fields contain numeric state, a UUID and a boolean, without query text or
credentials. Ledger lines grow, while the existing line and time retention
policies are unchanged.
On this checkout's 75,315 SERP rows, the proposed fields would add about
12.48 MB, or 166 bytes per row, to the existing 23.06 MB of SERP records.
That is about 54% more SERP ledger storage and additional I/O in the existing
full-ledger writer. No historical rows are backfilled to produce this estimate.

### Before/after evidence

The new regression file initially failed all four original cases because
`breaker` and `run_id` were absent. Its final five tests use the real public
callers with stubbed HTTP and controlled time. They exercise five failures,
cooldown skips, a failed SD probe, successful SD/BD/image recovery, BD async
fallback probe attribution, BD's unchanged `short_html` counter, and distinct
run identifiers in separate Node processes. HTTP is stubbed so these tests
make no paid calls; they are not production-recovery evidence.

Separately, eight real rows were replayed through `recordProviderCall()` before
and after the edit with a scratch ledger. Six SERP rows gained only run
correlation fields. Both non-SERP page rows were unchanged. All previous fields
matched after excluding the recording timestamp. Examples preserved were SD
organic HTTP 400, BD HTTP 200 and SD images HTTP 400. Historical breaker values
were not invented for these replays. All 109,049 source records remained
unchanged, confirmed by `sha256sum -c` on the original ledger.

`node --test --test-timeout 300000 tests/unit/serp-breaker-telemetry.test.mjs tests/unit/serp-volume-post-fix.test.mjs scripts/lib/serp-fallback-attribution.test.mjs scripts/lib/provider-telemetry.test.mjs`
passed: 20 tests, zero failures. The existing unit-test collector lists both
`tests/unit/serp-breaker-telemetry.test.mjs` and the original acceptance test,
without a manifest or workflow change.

The dependent-test sweep used
`rg -l 'url-discovery|provider-telemetry' tests scripts --glob '*.test.*'`
followed by `xargs node --test --test-concurrency=4 --test-timeout 300000`.
Across 59 files, 779 tests passed and one failed:
`scripts/lib/scraper-sb-latch.test.mjs:52`, with
`checkScrapingBeeCredits reports credits unavailable` (`true !== false`).
Loading both changed modules from `git show origin/main:<path>` using a Node
preload hook reproduced that exact failure on main: two passed, one failed.
It is not introduced by these diagnostics.

`GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`
passed with `lint-workflows: all gates green`, exit 0. The log explicitly
skipped unavailable `actionlint`; CI runs it. After the final test adjustment,
`node --test --test-timeout 300000 tests/unit/serp-breaker-telemetry.test.mjs tests/unit/serp-volume-post-fix.test.mjs`
passed: 10 tests, zero failures. No TypeScript files changed.

### Still unverified

- The exact cause of SD's generic HTTP 400 needs a controlled live request or
  provider diagnostics. `SCRAPINGDOG_API_KEY` is absent in this environment.
- A production five-failure trip followed by recovery needs new production
  rows after this instrumentation lands. Existing ledger history cannot prove
  it, and mocked integration tests do not substitute for it.
- The elevated weekly SB spend remains the result recorded below. Reducing it
  belongs to BRO-3386 and BRO-4936; this change makes no spend-reduction claim.

## Original production comparison

The ledger does **not** confirm a reduction in total ScrapingBee SERP volume or
credits. For the complete UTC week October 19 through 25, it records 3,138 calls
and 75,375 credits, up 477.9% and 482.0% from the card's August 31 baseline.
Explicit null-fallback calls decreased from 543 to 332, down 38.9%; their share
decreased from 100% to 10.58%. This narrower improvement cannot establish that
BRO-2939 caused the change: traffic, callers and instrumentation also changed.

This is a verification result, not a new provider-routing fix. Existing main
already tags fallbacks and records scrubbed SD diagnostics. The missing
`tests/unit/serp-volume-post-fix.test.mjs` prevented the card's acceptance command
from running. The added test exercises the real read-only analyzer, including
negative evidence and incomplete coverage; passing it does not assert that
production spend fell.

## Comparison

Baseline numbers are supplied by BRO-3344, not reconstructed from a baseline
ledger. Post-fix figures below are observed ledger calls and recorded credits,
not independently reconciled provider invoices or a dollar estimate.

| Metric | Week of August 31 | October 19 to 25 |
| --- | ---: | ---: |
| SB SERP calls | 543 | 3,138 |
| SB SERP credits | 12,950 | 75,375 |
| All SB credits | 13,372 | 158,841 |
| SERP share of SB credits | 96.84% | 47.45% |
| Explicit null-fallback SB SERP calls | 543 | 332 |
| Null-fallback share of SB SERP calls | 100% | 10.58% |
| `fallback_from=scrapingdog` calls / credits | Not available | 1,746 / 41,875 |
| `fallback_from=brightdata` calls / credits | Not available | 1,060 / 25,200 |
| Missing fallback tags | Not available | 0 |

| UTC day | SB SERP calls | Credits |
| --- | ---: | ---: |
| 2026-10-19 | 265 | 6,500 |
| 2026-10-20 | 450 | 11,075 |
| 2026-10-21 | 390 | 9,625 |
| 2026-10-22 | 372 | 9,200 |
| 2026-10-23 | 690 | 16,275 |
| 2026-10-24 | 438 | 10,350 |
| 2026-10-25 | 533 | 12,350 |

The adjacent October 18 to 24 window contains 2,785 observed calls,
67,525 credits and 339 explicit null fallbacks. However, the four immutable
snapshots documented below do not bracket its start: their earliest record is
October 18 at 00:00:02.013. With those inputs the analyzer correctly exits 2,
with `coverage.spansWindow=false` and `comparison=null`. These adjacent-window
counts are not a second verified full-week comparison.

The largest callers by credits are `gather-reviews.js` (1,557 calls / 36,725
credits), `opening-night-poller.js` (600 / 14,750), and
`discover-opening-night-reviews.js` (402 / 9,925). The 332 null-fallback calls
are entirely `discover-opening-night-reviews.js` (197 / 4,925) and
`ob-discovery-ticket-links.js` (135 / 3,375). Null does not by itself prove a
latched breaker: skipped, unavailable or deliberately bypassed providers also
produce null. A non-null tag identifies the preceding provider, not necessarily
an HTTP failure: a successful empty result can also cascade. Tags do not retain
the complete SD to BD to SB chain.

## Scrapingdog 400 diagnostics

There are 100,441 SD SERP ledger rows in the week, including 2,301 failures.
Of those failures, 2,283 (99.22%) have HTTP status 400. These are ledger events,
not a request-retry count. Thirty-six failure rows lack `detail`.

All 2,247 HTTP 400 rows with diagnostics report the same provider message:
`Something went wrong, please try again`. The largest request-shape groups are:

| Message | Quoted | Operators | Non-ASCII | HTTP 400 calls |
| --- | --- | ---: | --- | ---: |
| Same generic provider message | true | 3 | false | 1,558 |
| Same generic provider message | true | 1 | false | 304 |
| Same generic provider message | true | 4 | false | 173 |
| Same generic provider message | true | 5 | false | 126 |
| Same generic provider message | true | 3 | true | 41 |
| Missing detail | unknown | unknown | unknown | 36 |
| Same generic provider message | true | 6 | false | 22 |
| Same generic provider message | true | 2 | false | 12 |
| Same generic provider message | false | 3 | false | 4 |
| Same generic provider message | true | 1 | true | 4 |
| Same generic provider message | true | 5 | true | 2 |
| Same generic provider message | true | 4 | true | 1 |

The remaining 18 failure rows are eight HTTP 502s, seven timeouts and three
connection resets. The logged failure class is a generic SD API error. These
diagnostics do not name a rejected parameter or prove that quotes, operators or
non-ASCII text caused the 400s. A provider-side explanation or controlled live
probe is still needed for that precise cause. No paid probe was made here.
The ledger also lacks a per-process breaker-transition correlation, so this
comparison cannot independently prove a five-failure trip followed by healing.

## Sources and reproduction

The raw ledger rotates. The current checkout alone covers October 24 to 26,
which cannot answer a full-week question. Daily aggregates retain volume but
drop `fallback_from` and `detail`; absent fields must not be read as null tags.
Historical raw snapshots were recovered through public read-only GitHub HTTP
requests, without scraping, private-repo writes or credentials.

Each source is `data/audit/scraper-spend-ledger.jsonl` at the following immutable
main commit. Their time ranges overlap, avoiding holes between snapshots.

| Commit | Rows | Earliest UTC timestamp | Latest UTC timestamp |
| --- | ---: | --- | --- |
| [01aaa7e3f101a1d760f554a352ddf0b651c2d7fc](https://github.com/thomaspryor/Broadwayscore/commit/01aaa7e3f101a1d760f554a352ddf0b651c2d7fc) | 69,524 | Oct 18 00:00:02.013 | Oct 20 23:59:38.221 |
| [385e875ff21e1fb626dfba774629a49c72de9613](https://github.com/thomaspryor/Broadwayscore/commit/385e875ff21e1fb626dfba774629a49c72de9613) | 77,387 | Oct 20 00:00:07.132 | Oct 22 23:56:06.698 |
| [b56c1f2f4d194e343f4204c7d17a81009573aacc](https://github.com/thomaspryor/Broadwayscore/commit/b56c1f2f4d194e343f4204c7d17a81009573aacc) | 84,541 | Oct 22 00:00:03.315 | Oct 24 23:51:33.164 |
| [3835dc6d8ea2733fda7e5dcfaf6f196142361cbf](https://github.com/thomaspryor/Broadwayscore/commit/3835dc6d8ea2733fda7e5dcfaf6f196142361cbf) | 64,767 | Oct 24 00:00:07.215 | Oct 26 04:47:22.664 |

Union these snapshots using exact-record identity, matching the existing ledger
merge policy. This gives 216,907 distinct input records. The SHA-256 of sorted
unique input lines, joined with newlines and a final newline, is
`140275fb48e65c05d941d223e7069f4ac7967b3064d4e68f3ca79e72af755d59`.
Exact duplicates are counted once, including one duplicate in October 25's
current raw ledger. Genuine differences in any field remain separate records.
Ledger capture can still omit calls upstream; overlapping snapshots cannot
prove completeness relative to the provider's billing system.

To reproduce, download the four immutable raw files into a temporary directory
inside the checkout, naming them by commit, then run:

```bash
node scripts/lib/serp-volume-post-fix.js 2026-10-19 2026-10-26 \
  snapshots/01aaa7e3f101a1d760f554a352ddf0b651c2d7fc.jsonl \
  snapshots/385e875ff21e1fb626dfba774629a49c72de9613.jsonl \
  snapshots/b56c1f2f4d194e343f4204c7d17a81009573aacc.jsonl \
  snapshots/3835dc6d8ea2733fda7e5dcfaf6f196142361cbf.jsonl
node --test tests/unit/serp-volume-post-fix.test.mjs
```

The analyzer makes zero network, paid-provider or LLM calls, writes no ledger
and has no cron. It exits 2 with `comparison: null` for an incomplete window or
missing attribution, and exits 1 for missing files or invalid JSON/dates.
Its test is collected by the existing `unit-test-collection.js` CI caller.
Remove downloaded snapshots after use; no raw ledger is included in this diff.

## Before/after and existing implementation

Before editing, the existing `topCallers()`, `topCallersByCredits()` and
`creditsByProvider()` reducers were run on the same recovered real records.
After editing, all seven daily counts and credits and both caller rankings
matched exactly. The sorted input SHA-256 stayed unchanged. Zero source
records changed. Examples before and after: October 19 265 / 6,500; October 23
690 / 16,275; October 25 533 / 12,350.

The real writers/callers are `recordProviderCall()` in
`scripts/lib/provider-telemetry.js` and `_serpWithChain()` in
`scripts/lib/url-discovery.js`. Main already has `withSpendFallback()`,
`if (sdAttempt.ran)` and `scrapingdogSerpFailureDetail()`. They were inspected
and left unchanged. `aggregateLedgerByDay()` in `provider-spend-core.js`, called
by `check-provider-spend.js`, deliberately omits the raw diagnostic dimensions;
the audit therefore reads raw snapshots instead of changing that writer.

`git ls-tree origin/main tests/unit/serp-volume-post-fix.test.mjs` was empty and
the acceptance command initially failed with `Could not find` that path.
`git log -S 'serp-volume-post-fix' --oneline -5` was also checked; this shallow
checkout exposes a boundary checkpoint, which cannot establish the original
fix's history. The GitHub comparison of the stranded
`land/bro-3344-serp-fallback-5036-plan` branch showed old telemetry plus unrelated
image/BRO-5036 changes, not a missing volume verification test. No branch was
merged, pushed or deleted.

## Validation record

Commands below used the temporary download filenames from this run. The
temporary directory was removed afterwards; the immutable sources above allow
the same input to be reconstructed.

```bash
# Initially failed: Could not find 'tests/unit/serp-volume-post-fix.test.mjs'.
# After the change: 5 tests passed, 0 failed.
node --test tests/unit/serp-volume-post-fix.test.mjs

# Passed: 5 tests, 0 failures.
node --test --test-timeout 300000 tests/unit/serp-volume-post-fix.test.mjs

# Passed: 10 tests, 0 failures.
node --test --test-timeout 300000 scripts/lib/serp-fallback-attribution.test.mjs scripts/lib/provider-telemetry.test.mjs

# Passed, exit 0: 3,138 calls / 75,375 credits / 332 null fallbacks.
node scripts/lib/serp-volume-post-fix.js 2026-10-19 2026-10-26 .tmp-bro-3344/2026-10-21.jsonl .tmp-bro-3344/2026-10-23.jsonl .tmp-bro-3344/2026-10-25.jsonl data/audit/scraper-spend-ledger.jsonl

# Passed, exit 0: 2,785 calls / 67,525 credits / 339 null fallbacks.
node scripts/lib/serp-volume-post-fix.js 2026-10-18 2026-10-25 .tmp-bro-3344/2026-10-19.jsonl .tmp-bro-3344/2026-10-21.jsonl .tmp-bro-3344/2026-10-23.jsonl .tmp-bro-3344/2026-10-25.jsonl data/audit/scraper-spend-ledger.jsonl

# Correct refusal, exit 2: five missing days, comparison null.
node scripts/lib/serp-volume-post-fix.js 2026-10-19 2026-10-26 data/audit/scraper-spend-ledger.jsonl

# Passed: lint-workflows.exit = 0; log ends "all gates green".
# actionlint unavailable, explicitly skipped by the harness.
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet

# Passed; exact test path printed, proving existing CI collection.
node scripts/lib/unit-test-collection.js | rg '^tests/unit/serp-volume-post-fix.test.mjs$'

# Passed, no whitespace errors.
git diff --check
```

No TypeScript, UI, scoring or content-quality pattern files changed, so their
specialized commands were not applicable. Only the four intended files remain
in the working tree. No commit, push, PR, workflow edit or Linear write was made.

## Follow-up recheck on main, 2026-10-26

At the start of this follow-up, HEAD and origin/main were both `a844016e`.
The acceptance command already passed, with 5 tests and 0 failures, and
`git diff origin/main -- tests/unit/serp-volume-post-fix.test.mjs scripts/lib/serp-volume-post-fix.js`
was empty. The `git log -S 'serp-volume-post-fix' --oneline -5` search returned
the shallow boundary checkpoint `f5757288`; it does not establish the original
merge history. No analyzer, telemetry or routing change was needed.

Downloading the same four immutable snapshots reproduced 216,907 distinct
records and the input SHA-256 above. The real CLI reproduced all three cases:

| Input / UTC window | Exit | SB calls / credits | Comparison |
| --- | ---: | ---: | --- |
| Four snapshots, October 19 to 25 | 0 | 3,138 / 75,375 | Available |
| Four snapshots, October 18 to 24 | 2 | 2,785 / 67,525 | Unavailable: start not bracketed |
| Checkout ledger, October 19 to 25 | 2 | 971 / 22,700 | Unavailable: October 19 to 23 absent |

The last row uses the checkout ledger through October 26 at 22:56:17.212 UTC.
Only the report's adjacent-window coverage claim changed. Source records and
all analyzer outputs stayed unchanged before and after that documentation fix.
Three daily examples remain October 19: 265 / 6,500; October 23: 690 / 16,275;
October 25: 533 / 12,350.

The actual writers remain `recordProviderCall()` in `provider-telemetry.js`
and the provider calls and `_serpWithChain()` in `url-discovery.js`. Raw ledger
rows have neither process/run identifiers nor consecutive-failure counts or
half-open outcomes. The 80 existing `breaker-transitions.jsonl` rows describe
daily spend ceilings written by `check-sd-breaker.js` and `check-bd-breaker.js`,
not the five-failure SERP guards. They cannot establish the requested recovery.

Read-only GitHub access also recovered three production job logs from October
25, without triggering any workflow or provider request:

| Job | SD SERP error markers | BD SERP error markers | Half-open / threshold markers |
| --- | ---: | ---: | ---: |
| [Gather reviews](https://github.com/thomaspryor/Broadwayscore/actions/runs/40171074500/job/121103906768) | 3 | 1 | 0 |
| [Collect review texts](https://github.com/thomaspryor/Broadwayscore/actions/runs/40172360547/job/121105714857) | 0 | 0 | 0 |
| [Collect review texts](https://github.com/thomaspryor/Broadwayscore/actions/runs/40172915833/job/121107404421) | 3 | 1 | 0 |

Every observed counted SERP error in these jobs was `1/5`. This sample does
not show a trip and cannot verify recovery after a trip. Logs were inspected
without retaining review text or queries in this report.

The 2,247 instrumented HTTP 400 rows still give only the same generic provider
message. There is no `SCRAPINGDOG_API_KEY` in this worker's environment, so a
controlled live probe could not be performed. The exact 400 cause and a real
five-failure trip followed by recovery remain unverified. Lowering the observed
weekly spend remains work for the named cluster cards, BRO-3386 and BRO-4936;
this verification supplies no evidence for a safe routing change.

The following focused command passed with 34 tests and 0 failures:

```bash
node --test --test-timeout 300000 tests/unit/serp-volume-post-fix.test.mjs scripts/lib/serp-chain-order.test.mjs scripts/lib/serp-fallback-attribution.test.mjs scripts/lib/provider-telemetry.test.mjs
```

The existing test imports the production analyzer, and
`scripts/lib/unit-test-collection.js` still collects that test. No function,
flag, script, cron or paid call was added. The analyzer continues to make zero
network or LLM calls. Temporary snapshots and logs were removed after checking.
