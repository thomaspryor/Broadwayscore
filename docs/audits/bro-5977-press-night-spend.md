# BRO-5977: Oct 29 press-night spend calibration

Checked 2026-10-31 against the ledger in checkout `2f675cef`. The ledger contains
82,590 records dated Oct 29 through Oct 31, including 4,904 tagged records for six
Oct 29 show-nights. Costs below use the production `pressNightSpentUsd()` function
and `loadProviderPricing()`, rather than provider billing totals or inferred URL
metadata.

| Oct 29 show-night | Tagged records | Tagged USD |
| --- | ---: | ---: |
| A Few Good Men | 817 | 0.470667 |
| Kelly McCaughan: Catholic Guilt | 910 | 0.793263 |
| Showstopper! The Kids Show | 459 | 0.338799 |
| The Greatest Story Ever | 764 | 0.568026 |
| The Heart | 943 | 0.634575 |
| The Lives of Others | 1,011 | 0.625743 |
| Total | 4,904 | 3.431073 |

The mean tagged cost is $0.571846; the maximum is $0.793263. These figures include
the poller, gatherer and outlet collector. They exclude the shadow lane: all 784
of its recorded calls have null `purpose` and `showId`, despite BRO-6616's ledger
commit step being present. Those calls ran Oct 30 01:32:12 through 06:51:50 UTC:
414 Scrapingdog calls (842 credits), 367 Bright Data calls and three ScrapingBee
calls (three credits), totaling $0.626577 at the configured rates.

Retain `PRESS_NIGHT_CAP_USD = 2.00` and the owner's Option A for the lane, poller
and collector. Even assigning **all** recorded shadow cost to the most expensive
tagged night gives $1.419840, below the $1.60 warning threshold and $2 ceiling.
The ceiling is 1.41 times that conservative bound. The observed sample supports
keeping the current value; it does not justify introducing a detection cutoff.
The gatherer's existing hard cap stays in effect.

This comparison covers recorded scraper costs, not missing ledger writes or LLM
costs. It does not claim an exact allocation of historical shadow calls to shows.
No historical rows were rewritten. The shadow now calls `runShadowNight()` to
apply the same count-and-warn scope as the live driver, with per-show attribution
through `withSpendShow()`. Future recorded calls can be grouped without that
historical ambiguity. The existing shadow workflow already commits these rows.

Validation:

- Before the fix, the card's acceptance command passed 21/21; the live driver's,
  poller's and collector's tagging was already on main. `git log -S
  'beginPressNightSpend' --oneline -5 -- scripts/lib/spend-purpose.js` identifies
  `874f28c4`; these paths and the acceptance test match `origin/main`.
- A replay with real show metadata read from the core-data repo's `origin/main`
  exercised the original `runLaneNight()` call and the new shadow wrapper for
  A Few Good Men, The Lives of Others and Showstopper! The Kids Show. All three
  changed from null purpose/show attribution to their expected show-night tags
  and show IDs. A fourth, off-night replay remained untagged and gained its show
  ID. Network ports were stubbed; no paid calls or historical data writes ran.
- The wrapper's tests exercise the real runner and telemetry, including an
  already exceeded cap, scope restoration after rejection and off-night cleanup.
  No paid fetches, LLM calls, API requests or additional cron runs are introduced.

Commands run:

```sh
# Before and after: 21 passed, zero failed.
node --test scripts/lib/scrapingdog-press-night-cap.test.mjs

# New tests alone: three passed, zero failed.
node --test --test-timeout 300000 tests/unit/opening-night-shadow-spend.test.mjs

# Related tests together: 64 passed, zero failed.
node --test --test-timeout 300000 \
  scripts/lib/scrapingdog-press-night-cap.test.mjs \
  tests/unit/opening-night-shadow-spend.test.mjs \
  tests/unit/opening-night-lane-shadow.test.mjs \
  tests/unit/opening-night-lane-driver.test.mjs \
  tests/unit/lane-spend-ledger-commit.test.mjs \
  tests/unit/lane-arm-decision.test.mjs

git diff --check

# Exit 0, all gates green; actionlint unavailable locally (CI runs it).
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
```
