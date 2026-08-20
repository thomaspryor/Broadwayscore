# Health-digest warning triage (BRO-104)

Card filed 2026-07-24 against that morning's digest (~11 warnings). Triaged
2026-08-19. Four weeks of drift means most of the original rows had already
changed state, so this documents **what each original row is now** plus the
rows that replaced them, and — more usefully — the root cause that the
original "Cron failed" row turned out to be an instance of.

Baseline for this pass (full-credential local run, 2026-08-19 18:2xZ):
`50 passed, 31 warnings, 4 errors (89 total)`.

Reproduce with:

```
set -a && . .env && set +a && RESEND_API_KEY= OWNER_EMAIL= node scripts/health-check.js
```

A bare `node scripts/health-check.js` is **not** a valid baseline: without
credentials ~10 rows degrade to `Skipped — no <TOKEN>` warnings that say
nothing about production. The first run of this session made that mistake and
reported 31 warnings that were mostly local-environment artifacts.

---

## 1. "Cron failed: Update Cast Changes (2d ago)" — RESOLVED, no longer failing

`update-cast-changes.yml` last 8 scheduled runs are all `success`, most
recently 2026-08-19T09:22Z. Schedule is `0 9 * * 3,6` (Wed + Sat), and
`data/cast-changes.json` was 18h old at triage time — inside threshold. The
2026-07-24 breakage healed at some point in the intervening four weeks.
Nothing to fix; the row is green.

## 2. "Cron failed: Update Show Score (1h ago)" — transient churn

Now reports `Cron: Update Show Score: Last run still running (started 0h ago)`.
This is the digest observing an in-flight run, not a failure. Same shape as the
three sibling rows in the same run (`Collect Review Texts`, `LLM Ensemble
Score`, `Test Suite` — all "still running"). Genuinely informational.

## 3. Freshness — one real ERROR, and it was the interesting one

The 2026-07-24 "Freshness 10/14" rows have all refreshed. As of 2026-08-19 the
freshness block is 10 pass / 3 off-season-skip / **1 error**:

```
❌ Freshness: lottery-rush.json: 6d old (error threshold: 3d)
⚠️ Cron failed: Update Lottery/Rush: no success in 192h
```

Both rows, one root cause. `update-lottery-rush.yml` had failed **9
consecutive times** since 2026-08-16:

```
ReferenceError: isBroadwayCategory is not defined
    scripts/scrape-lottery-rush.js:55
```

Two sessions touched the same import block on 2026-08-14, six hours apart:

- `6a1563c4f39` (11:42, #1428 follow-up) **added**
  `const { isBroadwayCategory } = require('./lib/venue-classification')`
  as part of deduping 18 scripts onto the shared helper.
- `2cce8893917` (17:46, BRO-218 premium_proxy migration) rewrote the same
  import block and **dropped that line**, leaving the call site at module
  scope with nothing behind the name.

Nothing caught it. `node --check` only parses; the script has no unit test;
the reference is at module scope so it throws at *load*, before any argument
handling. It surfaced two days later as a red cron, and by the time anyone
looked the data was 6 days stale and the digest was showing an ERROR.

**Fixed** in `7fa70077e38` — require restored. Verified:
`node scripts/scrape-lottery-rush.js --dry-run --source=bwayrush` runs to
completion, 17 changes across 75 shows.

### 3a. The same bug was sitting in 7 other scripts

A missing identifier is a whole-file crash that review does not reliably catch
but a linter catches for free, so the fix was worth generalising. An ESLint
`no-undef` sweep over `scripts/**/*.js` (1671 files) surfaced 7 more
references to names that are never defined or imported — each an
unconditional crash the first time that line runs:

| File | Identifier | Consequence |
|---|---|---|
| `validate-data.js:887-888` | `err` (helper is named `error`) | the >5-mismatch autofix-cap branch throws instead of failing loud — **in the enforcement gate itself** |
| `collect-review-texts.js:3285` | `url` (should be `ctx.url`) | sits inside a bare `catch {}`, so the ReferenceError was **swallowed** and `canUseBrowserbase()` has been receiving `undefined` — the per-domain Browserbase cap the comment claims is "unified in one place" was never actually enforced |
| `scrape-show-score-audience.js:273` | `isChallengeOrGarbage` | not imported from `./lib/scraper` (BRO-218 added the call, not the require) |
| `audit-show-review-gap.js:1464` | `filledDateOutsideWindow` | not imported from `./lib/flagged-recovery` |
| `fantasy-weekly-email.js:269` | `syncResult` | block-scoped to the `try` at :236; the notification template is outside it |
| `audit-help-flag-safety.js:302` | `isRegexStart` | never defined anywhere — lived in 51 lines of unreachable code after an unconditional `return src;` |
| `migrate-reroute-backlog.js:61,226` | `titleGroups` | referenced by both `--cross-market` call sites but never built; every `--cross-market` run died before doing any work |

All 8 fixed in `3ff2009476a`.

### 3b. Prevention

`scripts/tests/scripts-no-undef.test.mjs` (`8004000f33e`) — static ESLint
`no-undef` gate over `scripts/**/*.js`, registered in
`tests/unit-test-manifest.txt` so it runs in the CI `node --test` batch.
Runs in 4s.

**The gate is at zero with no baseline allowlist.** If it fails, a script
references something that does not exist — fix the import, don't add an
exception. `browser: true` is enabled because scrapers pass `page.evaluate()`
callbacks that legitimately touch `document`/`window`/`navigator`; those run
in the page, not in node, and are the only remaining matches.

Negative control (this is what makes it a gate rather than a green checkmark):
deleting the `isBroadwayCategory` require again makes it fail with the exact
production error —
`scripts/scrape-lottery-rush.js:55 — 'isBroadwayCategory' is not defined.` —
and restoring the line makes it pass.

## 4. The grouped count rows ("Audience 0/1", "Pipeline 5/6", "Quality 1/2", "Sync 6/7")

These four are all green or informational now:

- **Audience coverage 0/1** → `No open shows with unlinked audience sources` (pass/skip).
- **Pipeline 5/6** → all 6 pipeline rows pass (`rebuild-reviews` 0h, `update-show-status` 6h, `collect-review-texts` 7h, `weekly-grosses` 7d, `weekly-integrity` 4d, `test` 1h).
- **Sync 6/7** → 5 pass, 2 warn: `cast coverage: 1 empty cast: Paranormal Activity` and `baseline drift: Reviews dropped: 19870 vs baseline 19882` (a 12-review delta, well inside normal flag/rebuild churn — the row exists to catch cliffs, not drift of this size).
- **Quality 1/2** → the standing warnings are `corpus drift` (7 audits drifting, each with its own linked report) and `outlet domain moves` (see below). Both are worklist rows by design: they report a backlog, they are not a broken check.

## 5. Stuck work — the #337 drain DID take

Reported before/after, which was the actual ask:

| Row | 2026-07-24 | 2026-08-19 | Delta |
|---|---|---|---|
| Paused P0/P1 | 41 | **19** | −22 (−54%) |
| Orphaned in-progress | 50 | **34** | −16 (−32%) |
| Paused P2/other | 28 | **4** | −24 (−86%) |
| **Total** | **119** | **57** | **−62 (−52%)** |

The drain's re-queue took. Every one of the three counts more than halved or
close to it. The rows still warn because they are *threshold* rows (anything
>0 is worth a glance), not because the drain failed. The current 19 paused
P0/P1s are also not a flat backlog: 9 are awaiting a scheduled recheck
(earliest due 2026-08-17) and 4 are parked via tab-close, which the row itself
annotates and excludes from the headline count.

## 6. Credits rows — left as-is, and CI *does* pass the key

Per the card, `Credits: ScrapingBee` (acknowledged, expiry) and
`Credits: ScrapingDog` (skipped locally) were left alone. The one thing worth
confirming was whether the *CI* health workflow is missing
`SCRAPINGDOG_API_KEY` too — it is not:
`.github/workflows/data-health-check.yml` passes it. The local skip is a
local-env artifact only.

---

## Rows deliberately left as warnings, with the reason

Every remaining warning is true-state. Grouped by why:

**a. Structurally unmeasurable from a dev machine (5 rows).** `Push-retry
deadman`, `Dispatch outcomes: abandoned`, `Dispatch health: dead-launch rate`,
`Headless dispatch: success rate`, `Digest: content-invariant check`. Each
reads a `data/audit/*.jsonl` ledger that is gitignored, per-machine, and
written only where dispatches actually launch. These already say so in their
own message text — they are correctly self-annotating and there is nothing to
fix from here.

**b. Backlog counters, working as designed (6 rows).** The `Data quality:
* lifetime sweep` family (cv-wrongproduction 842, fulltext-mentions-show 618,
slug-mismatch 2386, roundup-url-mismatch 73, revival-unverified 41) plus
`cross-outlet attribution drift`. These report corpus backlog size. A non-zero
count is the normal state of a 19,870-review corpus; they are worklists, not
failures.

**c. No measurement taken this cycle (2 rows).** `Coverage: SERP census
recall` (0 of 21 SERP query-runs returned any raw result — provider outage,
run explicitly NOT recorded to the trend) and `Coverage: adversarial probe`
(this week's sample had nothing measurable). Both correctly report "no
evidence either way" rather than inventing a verdict. Nothing to fix; they
resolve when the provider recovers.

**d. Genuinely awaiting a human judgment call (2 rows).**
- `Quality: coverageExpectation drift: ap, broadwaynews, latimes` — three
  outlets need a coverage-expectation re-decision. That is an editorial call.
- `Quality: outlet domain moves` — `theatrereviews.design` name-matches the
  registered T3 outlet `theatre-reviews-limited` (domain `theatrereviews.com`).
  **Investigated and deliberately not merged.** The check's own hint says
  "confirm the host really belongs to that outlet" first. Evidence is one
  occurrence (`/now-you-see-me-live/`, on `now-you-see-me-live-west-end-2026`),
  and fetching both that URL and the site root returns pages branded only
  `theatrereviews.design` with no "Theatre Reviews Limited" or Joseph Verlezza
  attribution anywhere. Adding it to `domainAliases` on a name match alone
  would attribute a review to a registered, tier-weighted outlet on no
  evidence — a scoring-corruption risk that is strictly worse than the one
  dropped review. The row stays open as the confirm-me prompt it is designed
  to be.

**e. Local-environment artifacts, already handled correctly in CI (1 row).**
`Cookies: expiration: data/cookies/ not found` — `health-check.js:1721`
returns `pass` ("Skipped in CI (cookies managed on Mac Studio)") when running
in CI, so this row never appears in the digest the owner actually reads. It
fires only from a worktree that has no `data/cookies/`.

**f. Owned by other work, per the card's coordinate note (2 rows).**
`SEO: health` (west-end simulated phone score 67, flagged in-row as
"simulated test only; real visitors are fine, usually ignorable") and
`Secrets: health`.

---

## Known-open, filed but not fixed here

Three rows are real and out of BRO-104's scope. They are named here so they
are not mistaken for triaged-and-closed:

- **`❌ Main: red streak`** — main's Test Suite had no confirmed-green run in
  2.2h (10 failing runs), first red commit `449b4e7ec`, job "E2E Tests, Design
  Token Drift Guard, Test Summary". This is an ERROR row, not a warning, and
  is the most urgent item in the digest.
- **`❌ Autofix: jobs actually succeeding` / `❌ Autofix: throughput`** — the
  auto-fix loop is dead (3 jobs launched in 7d, 0 reported back, 0 succeeded;
  0 dispatches on each of the last 5 days). Same starvation shape as #1184.
- **`⚠️ Quality: outlet-heartbeat red flags`** — heartbeat monitor last ran 9d
  ago (>8d); produced by `audit-critic-coverage.yml`.
