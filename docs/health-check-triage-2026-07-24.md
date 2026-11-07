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

---

# Second pass — 2026-08-26 (BRO-104 re-dispatch)

The card was re-dispatched a week after the 2026-08-19 pass above. Fresh
baseline, same reproduce command:

```
set -a; . ./.env >/dev/null 2>&1; set +a
RESEND_API_KEY= OWNER_EMAIL= node scripts/health-check.js
```

`58 passed, 24 warnings, 3 errors (89 total)` (2026-08-26 20:2xZ).

(Note for anyone re-running: `. .env` returns the exit status of its last line,
which is non-zero on this repo's `.env`. A `set -a && . .env && …` chain
short-circuits and the health-check never runs — use `;` separators as above.)

## Where the original card's six items stand

| # | Original row | 2026-08-26 state |
|---|---|---|
| 1 | Cron failed: Update Cast Changes | **Green on a live run** — `2026-08-26T09:30:04Z success`; last 6 scheduled runs all success; `data/cast-changes.json` 20h old, inside threshold |
| 2 | Cron failed: Update Show Score | **Still red, but not for its own reason** — see "one root cause" below |
| 3 | Freshness 10/14 | **13 of 14 fresh**, 3 off-season skips, 1 warn (`video-reviews.json` 8d) — again not a collector fault, see below |
| 4 | Audience 0/1, Pipeline 5/6, Quality 1/2, Sync 6/7, Workflow repeat-failure 0/1 | **Four of five fully green.** Audience → `No open shows with unlinked audience sources`. Sync → 7/7 pass (incl. `baseline drift: all at or above baseline` and `cast coverage: 26 active Broadway shows all have cast data`, both of which warned on 8/19). Workflow repeat-failure → gone. Pipeline → 5 pass + 1 warn (`weekly-integrity`, real, filed). Quality → `outlet domain moves` now passes (the `theatrereviews.design` judgment call from 8/19 cleared itself); 3 worklist warns remain |
| 5 | Stuck work 41 / 50 / 28 | **Fixed this session** — see the before/after table below |
| 6 | Credits SB acknowledged / SD skipped | **All four credit rows green, no acknowledgment needed.** SB 262k (26%), SD 1787k (45%) — the SD row was a local-key gap and the key is present now, CI was never missing it — BD $45.43 balance, BB fine |

## One root cause behind items 2 and 3: pushes to main are failing

`Update Show Score` and `Weekly Video Reviews` both **complete their work and
then die at `git push`**. Neither is a scraper or data bug.

- Show Score run `33006262338`: scraped fine, committed `04ac9a75` (2 files,
  +84/−10), then `push-with-retry: fetch could not restore ancestry to the
  shallow checkout's original boundary … Aborting instead (task #466)`.
- Weekly Video Reviews run `32691270611`: `Extracted: 17`, then 5 push attempts
  plus the Git Data API fallback all failed → `All push attempts failed`.
  `data/video-reviews.json` last *landed* on 2026-08-18, which is exactly the
  8d the freshness row reports.

The scale, from the `push-retry-failures` ledger branch
(`git show origin/push-retry-failures:failures.jsonl`, 618 rows):

| Day | retries-exhausted | shallow-ancestry-unrecoverable | commit-dropped-post-push |
|---|---|---|---|
| 2026-08-23 | 1 | – | – |
| 2026-08-24 | 53 | – | – |
| 2026-08-25 | 232 | – | – |
| 2026-08-26 | 273 | **57** | 2 |

Today's top losers: Test Suite ×109, Rebuild Reviews (Fast) ×65, Gather Review
Data ×23, Rebuild Reviews Data ×23.

**New evidence worth acting on:** `shallow-ancestry-unrecoverable` had never
fired before today. Its first occurrence is `2026-08-26T17:39:10Z` and it hit 57
times in the following three hours (17Z:4, 18Z:23, 19Z:28, 20Z:2). The abort
string itself is old (`092ede5a011`, 2026-07-26), so this is a *newly reached*
path, landing ~2h after `18db26e1515` / `ef673aea2c5` ("push-with-retry.sh
escalates the shallow-fetch bound after a fast rejection") went in earlier the
same day.

**Deliberately not fixed here.** `scripts/lib/push-with-retry.sh` is
critical-tier shared infra (CLAUDE.md §18), it was being actively edited by
another session three hours before this triage, and the systemic effort is
already carded — BRO-2373 (P0: shallow-fetch fails identically on every retry
under heavy churn), BRO-2217 (exits 0 on an unrecoverable shallow-ancestry
abort), BRO-354 (the deadman row itself). The timeline above is posted to
BRO-2373 rather than acted on unilaterally.

## Item 5 — stuck work: the rows were measuring a board nobody closes

The 8/19 pass reported the drain had worked (119 → 57). A week later the raw
counts were **back up to 115**, which looked like the drain unwinding. It was
not.

`checkStuckWork` reads the **Notion brain** (`scripts/lib/stuck-work.js` →
`fetchBrainCards(NOTION_API_KEY)`, zero Linear support). The board moved to
Linear on 2026-08-12 (CLAUDE.md §6: "Linear is the source of truth"). Sessions
close their work in Linear and never touch the Notion twin, so the Notion card
sits Paused/In-progress forever. The counts can only grow. Notion is still
*written* to (newest edit at triage time: 2026-08-26T19:22Z), so this is
accumulation, not a frozen snapshot.

Cross-checking each stuck card's title against all 2,421 Linear issues
(`includeArchived: true`) made the size of the illusion concrete:

| Bucket | raw | Linear twin CLOSED | twin still open | no twin at all |
|---|---|---|---|---|
| paused P0/P1 | 40 | 4 | 26 | 10 |
| orphaned in-progress | 55 | **35** | 3 | 17 |
| paused P2/other | 20 | **16** | 1 | 3 |

**Fix (`0e4b3e4020a`):** `scripts/lib/stuck-work-linear-reconcile.js` +
health-check wiring. A card is dropped **only** when its Linear twin is
explicitly `completed`/`canceled`/`duplicate`. Two deliberate conservatisms:

- a card with **no twin at all keeps counting** — the Notion→Linear mirror froze
  at task id 1285 (2026-08-20), so anything filed in Notion afterwards has no
  twin and must not vanish;
- an **unreachable Linear is a no-op, never a shrink** — an API failure that
  quietly zeroed a stuck-work row would be strictly worse than the bug.

Each row now names the exclusion in its own text, so the number explains itself.

Before/after on the same corpus, minutes apart:

| Row | 2026-07-24 (card) | 2026-08-26 raw | 2026-08-26 reconciled | Δ vs raw |
|---|---|---|---|---|
| Paused P0/P1 | 41 | 40 | **36** | −4 |
| Orphaned in-progress | 50 | 55 | **20** | −35 |
| Paused P2/other | 28 | 20 | **4** | −16 |
| **Total** | **119** | **115** | **60** | **−55** |

The 60 that remain are true state: 26 paused P0/P1s are open in Linear too, and
every survivor is either live work or genuinely untracked. The row still warns
because it is a threshold row (>0 is worth a glance).

Tests: `scripts/tests/stuck-work-linear-reconcile.test.mjs`, 8 cases, registered
in `tests/unit-test-manifest.txt`. The two that matter are the ones that pin the
conservatisms — "a card with NO Linear twin is never dropped" and "an
unreachable/empty Linear is a NO-OP, never a shrink".

## The two remaining fixable warnings, filed not fixed

Both are real, both are out of what this session could land safely, and both are
`.github/workflows/**` (critical-tier, CLAUDE.md §18 review-gate territory):

- **`Quality: outlet-heartbeat red flags: Heartbeat monitor last ran 16d ago`.**
  `audit-critic-coverage.yml` reported **success** on 2026-08-17 and 2026-08-24,
  but `data/audit/outlet-heartbeat.json` last landed 2026-08-10. Line 138 is
  `bash scripts/lib/push-with-retry.sh 5 main || echo "::warning::push failed;
  will retry next week"` — the job swallows a lost push into a warning and exits
  green, so two consecutive weekly snapshots vanished with a green checkmark.
  This is the exact "never `|| true` on git push" rule in
  `memory/feedback_silent_workflow_failures.md`, and the digest row is the only
  thing telling the truth.
- **`Pipeline: weekly-integrity: Last success 11d ago`.** `weekly-integrity.yml`
  failed on 2026-08-23, 2026-08-09 and 2026-08-02 (3 of the last 4 Sundays) at
  the step **"Detect and auto-fix critic typos"**.

## Every remaining warning, classified

All 24 are true state. The 8/19 buckets still hold; what changed is which rows
are in them.

**Root-caused to the push failure above, tracked in BRO-2373/BRO-2217/BRO-354
(4 rows):** `Cron failed: Update Show Score`, `Cron failed: Weekly Video
Reviews`, `Freshness: video-reviews.json 8d`, and the `❌ Push-retry deadman`
error row itself.

**Real, filed this session (2 rows):** `Quality: outlet-heartbeat red flags`,
`Pipeline: weekly-integrity`.

**In-flight, not failures (2 rows):** `Cron: Rebuild Reviews` and `Cron: Test
Suite` both report "still running (started 0h ago)" — the digest observing a
live run.

**Backlog counters working as designed (5 rows):** `Quality: corpus drift` (7
audits, each with a linked report), and the `Data quality: * lifetime sweep`
family — cv-wrongproduction 852/404 shows, slug-mismatch 2393/900 shows,
revival-unverified 44, cross-outlet attribution drift. A non-zero count is the
normal state of a 20,116-review corpus; these are worklists, not failures.

**Structurally unmeasurable from a dev machine (5 rows):** `Dispatch outcomes:
abandoned`, `Dispatch health: dead-launch rate`, `Headless dispatch: success
rate`, `Autofix: daily canary`, `Digest: content-invariant check`. Each reads a
gitignored, per-machine `data/audit/*.jsonl` ledger and each already says so in
its own message text. Correctly self-annotating; nothing to fix from here.
(BRO-231 tracks the CI-side blindness this creates.)

**Awaiting a human judgment call (1 row):** `Quality: coverageExpectation drift:
ap, broadwaynews, latimes` — an editorial re-decision on three outlets.

**No measurement taken this cycle (1 row):** `Coverage: adversarial probe` — the
naive search found 3 URLs the pipeline hasn't discovered (`the-gin-game-2026`,
`the-wind-in-the-willows-theatre-on-kew-off-west-end-2026`). Working as
intended: it reports the gap it found.

**Stuck work (3 rows):** reconciled above; threshold rows, >0 by design.

**Local-environment artifact (1 row):** `Cookies: expiration: data/cookies/ not
found` — `health-check.js` returns `pass` in CI, so this never reaches the
digest the owner reads. Fires only from a worktree.

**Owned by other work (1 row):** `SEO: health` — `/west-end` simulated phone
score 67, flagged in-row as "simulated test only; real visitors are fine".

## Errors (3) — named so they are not mistaken for triaged-and-closed

- `❌ Push-retry deadman` — the 618-row story above. BRO-2373 / BRO-2217 / BRO-354.
- `❌ Revenue: affiliate health: snapshot is 3d old` — `data/audit/affiliate-health.json`
  last landed 2026-08-24 07:48, i.e. it stopped exactly when the push failures
  spiked. Same root cause; the monitor runs, its snapshot cannot land.
- `❌ Autofix: throughput` — 0 dispatches on each of the last 7 days, the #1184
  starvation shape. Unchanged from 8/19 and still out of scope here.

The `❌ Main: red streak` row from 8/19 has cleared.
