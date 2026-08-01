# Browserbase daily-cap step-down runbook (Scraping v2 T13)

Lowering the Browserbase daily ceiling **250 → 100 → 60** is evidence-gated. This
is the procedure. Do not skip the gate: the cap is the only thing standing
between a runaway script and an unbounded bill (February 2026: 12,876 sessions
in one week = $1,287, before any caps existed).

## Where the number lives

ONE constant: `DEFAULT_MAX_SESSIONS_PER_DAY` in `scripts/lib/browserbase-caps.js`,
read through `resolveMaxSessionsPerDay()` by **both** enforcement points:

| Path | How it counts |
|---|---|
| `scripts/collect-review-texts.js` | local usage file (`data/collection-state/browserbase-usage.json`) |
| `scripts/lib/bww-rr-discover.js` | live Browserbase API session count |

They cap the *same account*. They used to each hard-code `250`, with
bww-rr-discover.js only asserting the invariant in a comment — editing one would
have left the other at 250, so the cap would read as lowered while half the
spend stayed uncapped. Now there is one edit site.

**Preferred lever is the repo variable, not the code default.**
`opening-night-poller.yml` injects `BROWSERBASE_MAX_SESSIONS_PER_DAY` from
`${{ vars.BROWSERBASE_MAX_SESSIONS_PER_DAY }}` (same pattern as
`BROWSERBASE_KILL_SWITCH`). Unset/empty/0/garbage → falls back to the 250 code
default, never to 0 (a 0 ceiling would block every session account-wide).

So a step-down is a **repo-variable change with no deploy**, and a rollback is
the same change in reverse — seconds, not a PR.

```
gh variable set BROWSERBASE_MAX_SESSIONS_PER_DAY --body 100   # step down
gh variable delete BROWSERBASE_MAX_SESSIONS_PER_DAY           # revert to 250
```

## The gate — run this BEFORE touching the number

```
node -e "
const {computeStreak}=require('./scripts/lib/provider-spend-core.js');
const fs=require('fs');
const th=JSON.parse(fs.readFileSync('scripts/config/provider-spend-thresholds.json','utf8'));
const series=fs.readFileSync('data/audit/provider-spend-daily.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
console.log('billed days:', series.length, '| streak within thresholds:', computeStreak(series, th), '| target:', th.streakTargetDays);
"
```

Step down **only** when: `streak >= 3` consecutive billed days within the
thresholds in `scripts/config/provider-spend-thresholds.json`
(`browserbaseDailyUsd` currently $4) **AND** review yield is healthy — no drop in
reviews collected per opening, checked against the morning digest's yield line.

### Status as of 2026-07-31 — GATE NOT MET, do not step down

```
billed days: 1 | streak within thresholds: 0 | target: 7
2026-07-30  browserbase $22.50 (225 sessions)  vs $4/day threshold  → 5.6x OVER
            brightdata  $9.72                  vs $2.50/day         → 3.9x OVER
```

225 sessions/day is already close to the 250 ceiling. Dropping to 100 today would
clip roughly 125 sessions/day of *currently-running* work with zero evidence that
work is waste. **Find out what is spending 225 sessions/day first** — the
step-down assumes the demand-side fixes (Sprint 1) have already pulled real usage
well under the cap, and that has not been demonstrated.

## Procedure once the gate passes

1. Re-run the gate command; paste the output into the card. `streak >= 3`.
2. `gh variable set BROWSERBASE_MAX_SESSIONS_PER_DAY --body 100`.
3. Watch the next **3 billed days** in the morning digest:
   - cap-exhausted line stays absent (no run hit the ceiling), and
   - review yield per opening is unchanged.
4. If a cap-exhausted line appears or yield drops → revert immediately
   (`gh variable delete ...`) and stop. The cap is too low for real demand.
5. Only after 3 clean days at 100, repeat steps 1-4 for `--body 60`.
6. Whole-effort acceptance: **7 consecutive billed days within thresholds** at the
   final value, healthy yield, plus a Broadway replay test.

## Rollback triggers (any one → revert to 250 immediately)

- Morning digest shows a cap-exhausted line on a real opening night.
- Reviews-per-opening drops versus the prior week.
- A `Browserbase daily cap reached (N/M) — BWW RR discovery skipped` error in
  opening-night-poller logs.

Related: `memory/feedback_sb_credit_budget.md`, `memory/feedback_scraper_architecture.md`.
