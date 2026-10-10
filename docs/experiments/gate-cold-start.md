# Experiment: gate-cold-start

Setup contract for any new experiment: [`README.md`](./README.md).

## What's being tested

Does requiring a 2-page minimum before the email-capture modal can fire
("cold-start" arm) change modal capture rate vs no page minimum ("control"
arm)?

- **Flag key**: `gate-cold-start` (PostHog, project 332742)
- **Variants**: `control` (50%) / `cold-start` (50%), 100% rollout
- **Client**: `src/contexts/ProGateContext.tsx` — `COLD_START_FLAG` constant
  (`src/lib/gate-logic.ts`)
- **Registry entry**: `scripts/lib/flag-registry.js` (`REGISTERED_FLAGS`)
- **Experiment start**: 2026-07-21 — do not backdate when reading results
- **Canonical readout**: `node scripts/analyze-gate-cold-start.js` — DELETED
  at teardown (see "Conclusion" below); retrieve via `git show
  <pre-teardown-sha>:scripts/analyze-gate-cold-start.js` if the historical
  methodology needs re-checking.
- **Weekly automated monitor**: `scripts/monitor-gate-cold-start.js`
  (guardrails only — never judges the primary; see `monitor-gate-ab.yml`)
- **Weekly flag-parity guardrail**: `scripts/monitor-flag-parity.js` (card
  #250 — generic, covers every registered flag including this one)

## Attribution model — person-level ITT

A person's arm = the FIRST `$feature_flag_called` response in-window, and
ALL of that person's modal events count for that arm — including any events
the client stamped `fallback` because they fired in the seconds before the
flag resolved. Event-label attribution (an earlier draft) dropped those
events from the numerator while keeping the person in the denominator —
classic ITT contamination. Under person-attribution the pre-resolution race
can only attenuate the measured effect toward null, never bias an arm.
Persons with gate events but no exposure event (flags endpoint ad-blocked)
are reported as `unexposed` and excluded from comparison.

Two gotchas the analyzer specifically guards against:
1. `email_captured` fires from BOTH the gate modal and inline header/footer
   forms — modal-attributed events are `trigger != ''` only.
2. Fallback-labeled rows (flag never resolved) must be EXCLUDED, never
   merged into control.

## Metrics

Per arm: `EXPOSED` (distinct persons whose first flag response = arm),
`SHOWN` / `DISMISSED` / `CAPTURED` (modal events for those persons), primary
= captures/exposed (ITT).

## Pre-registered rules

- **Flag health**: exists, active, 50/50 split, 100% rollout,
  `ensure_experience_continuity: false`. Sticky-OFF is pre-registered-correct,
  not a bug: this experiment is anonymous-only (the experiment lock forbids
  `posthog.identify()`), continuity only affects identified persons, and
  anonymous assignment is already deterministic per distinct_id at fixed
  rollout. The per-flag expectation lives in `scripts/lib/flag-registry.js`
  and the weekly parity monitor alarms on drift in either direction. Anything
  else means the experiment isn't running as designed and any numbers read
  during the broken window are contaminated. Read via `node
  scripts/analyze-gate-cold-start.js` (per-experiment) or the generic weekly
  `scripts/monitor-flag-parity.js` (card #250).
- **Guardrail — capture collapse**: combined modal captures/week < 1 for 2
  CONSECUTIVE meaningful weeks (baseline ~4/wk pre-experiment) is grounds to
  consider reverting the cold-start gate.
- **Guardrail — impression split**: control:cold-start shown should stay
  roughly in the 2.5:1 band measured since real data became available
  (BRO-2952, 2026-09-07 amendment below — the original "~10:1" here was an
  untested pre-launch projection, never confirmed against real numbers).
  A further collapse toward parity means the treatment filter silently
  stopped applying, not that "it's working." Thresholds: `scripts/lib/gate-cold-start-rules.js`.
- **Primary judgment**: minimum 4 weeks (28 days) of experiment runtime
  before reading the ITT primary metric. `scripts/monitor-gate-cold-start.js`
  fires a one-time "time to look" nudge at that milestone — it never judges
  the primary itself.

## Full decision logic

Pure, testable, and the actual source of truth for the numbers above:
`scripts/lib/gate-cold-start-rules.js` (guardrail thresholds + alerting) and
`scripts/analyze-gate-cold-start.js` (attribution + metric computation).

## Amendments

- **2026-08-21 (BRO-1959)**: raised `exitIntent.minTimeOnPageSec` 5 -> 30 in
  `src/config/email-capture.ts` (aggressive preset) and its lock in
  `tests/unit/gate-logic.test.mjs`. The experiment cleared its pre-registered
  28-day minimum runtime on 2026-08-18 (start 2026-07-21); the last automated
  monitor run before that date (`data/audit/gate-cold-start-monitor-state.json`,
  2026-08-17) showed `flagHealthy: true` and no capture-collapse guardrail
  trips. This value is shared across both arms (not the treatment lever —
  `minPageViewsForPassiveGate` is), so raising it doesn't advantage either arm;
  it brings desktop's exit-intent dwell floor in line with the mobile
  scroll-gate raise from task #586. All other locked values are unchanged and
  the experiment (`minPageViewsForPassiveGate` treatment split) remains live.

- **2026-08-26**: the 4-week "time to judge" milestone alert (fired
  2026-08-24) turned out to be reading corrupted numbers — `scripts/analyze-
  gate-cold-start.js`'s HogQL queries were silently capped at ~100 rows by
  PostHog's API default (no explicit `LIMIT`), so it reported 0.00% captures/
  exposed in both arms against a true exposed population in the thousands.
  Root cause fixed (`scripts/analyze-gate-cold-start.js`, `scripts/analyze-
  email-gate-funnel.js` had the same gap in one query). Corrected 40-day
  readout: control 7,328 exposed / 2,011 shown / 10 captured (0.14% ITT),
  cold-start 7,343 exposed / 813 shown / 9 captured (0.12% ITT); combined
  captures/week 3.62, in line with the ~4/wk baseline — the funnel was never
  broken. Per-impression, cold-start converts ~2.2x higher (1.11% vs 0.50%)
  on its smaller shown population, but n=9 vs n=10 total conversions is not
  a significant difference. Owner decision (2026-08-26): extend the
  experiment rather than call a winner now — sample size is still too small
  after 5+ weeks. No config change; both arms continue running as-is.
  `primaryReadyAlertedAt` is already stamped (one-time alert, won't re-fire)
  — re-read with `node scripts/analyze-gate-cold-start.js --days=60` in
  ~3-4 weeks to reassess with a larger sample.

- **2026-09-07 (BRO-2952)**: the impression-split guardrail fired
  `control:cold-start shown = 208:75` (2.8:1, vs the pre-registered "~10:1")
  on 2026-08-31 and again 2026-09-07, read by the alert as "the treatment
  filter silently stopped applying." Investigated as a possible client-side
  regression or PostHog flag-payload change; found neither. What actually
  happened:
  - Flag health was fine both weeks (`flagHealthy: true`, exposed ~50/50 —
    1123:1153 on 09-07, 1227:1233 on 08-31).
  - The client-side filter (`coldStartCheckApplies` / `hasSeenEnoughPages` in
    `src/lib/gate-logic.ts`, wired in `ProGateContext.triggerGate`) has had
    no code changes since launch and its full test suite
    (`tests/unit/gate-logic.test.mjs`, 13 tests incl. the "EXPERIMENT LOCK"
    wiring checks) passes clean.
  - `scripts/analyze-email-gate-funnel.js`'s trigger breakdown for the same
    7d window (`data/audit/email-gate-funnel-monitor-state.json`) shows
    `gate_modal_shown` coming almost entirely from `exit_intent`/
    `scroll_depth`/`return_visitor` — the three triggers the cold-start
    filter actually gates. `page_view_limit` (exempt from the filter by
    design — see `triggerGate`'s blocking-trigger branch) is negligible, so
    it isn't diluting the ratio either.
  - The real cause: the "~10:1" figure was never measured — it was a
    pre-launch projection ("cut impressions ~85-90%" — see
    `scripts/analyze-email-gate-funnel.js` header) written before any data
    existed. The HogQL `GROUP BY` row-cap bug (fixed 2026-08-26, commit
    `b6d48ce42f5`) meant every "recent" 7-day reading before that date was
    near-zero noise (e.g. 08-24: `1:1` on an exposed base of ~50 each,
    against a true daily rate of ~300+) — not a valid baseline. The first
    three real 7-day readings (08-31: 230:86, 09-01: 226:86, 09-07: 208:75)
    all land in the same ~2.6-2.8:1 band: a real, stable selection effect
    (a meaningfully large share of engaged visitors — those who clear the
    30s exit-intent/scroll-gate dwell floor — do go on to view a 2nd page),
    just milder than the untested pre-launch guess.
  - No client behavior changed and no experiment arm was touched — this is a
    measurement/guardrail-threshold correction only, not a treatment change,
    so it does not invalidate the running experiment. `IMPRESSION_SPLIT_EXPECTED_RATIO`
    (10 → 2.5) and `IMPRESSION_SPLIT_MIN_RATIO` (5 → 2.2) in
    `scripts/lib/gate-cold-start-rules.js` now track the measured band, with
    a floor kept close under it (not down near 1:1) so a partial regression —
    the filter still applying, but to a shrinking subset of visits — still
    trips it, not only a full collapse to parity.
  - Second-opinion catch (Codex adversarial review) on the first draft of
    this fix: the guardrail computed `max(shown)/min(shown)`, which discards
    *which* arm is bigger — an inverted split (cold-start showing as much or
    more than control, e.g. from mislabeled arms or the filter applied to the
    wrong arm) would read as a "healthy" large ratio and never alert. Fixed
    to compute `controlShown / coldStartShown` directly and alert on
    inversion independent of the ratio floor.
  - Regression tests live in the **existing** colocated
    `scripts/lib/gate-cold-start-rules.test.mjs` (added by the original
    monitor PR, #247) — an earlier draft of this fix mistakenly believed the
    file had zero coverage and added a duplicate `tests/unit/` test file;
    that was wrong (the colocated file already had 16 tests and runs in CI
    via `scripts/lib/`'s own test glob, not the `tests/unit-test-manifest.txt`
    path) and has been corrected — the new BRO-2952 cases were merged into
    the existing file instead.

## Conclusion (2026-09-15)

**Decision: roll the treatment arm's 2-page-view minimum out to 100% of
traffic, permanently.** No more arm split — `minPageViewsForPassiveGate`
now applies to every visitor for every passive trigger (exit_intent,
scroll_depth, return_visitor). Tracked in Linear BRO-3422.

**Why now:** the experiment cleared its pre-registered 28-day minimum
runtime on 2026-08-18 and sat unconcluded for another 4 weeks (the
2026-08-26 "extend and recheck in 3-4 weeks" amendment above repeated the
same underpowered-wait mistake this conclusion corrects — see the
power-calculation note below).

**The numbers this decision rests on** (56 days in, cumulative, from
`data/audit/gate-cold-start-monitor-state.json` as of 2026-09-14):
- **Primary ITT metric (captures/exposed, per this doc's own "Metrics"
  section above):** control 0.142% (15/10,593), cold-start 0.103%
  (11/10,705) — cold-start is directionally BEHIND on its own pre-registered
  primary, not ahead. n=15 vs n=11 is not a statistically meaningful
  difference either way.
- **Power check (corrected — on the actual primary metric, captures/exposed,
  not a captures/shown proxy that an earlier draft of this note used by
  mistake):** the exposed populations are ~equal size (control and
  cold-start each get ~190/day, since the flag splits ALL traffic 50/50
  before either arm's gate logic even runs) but the rate gap is tiny
  (0.142% vs 0.103%, a 0.039-point difference). Detecting that at 80% power
  needs ~126,000 exposed/arm — roughly **666 days (~1.8 years)** at
  current traffic. This is even less reachable than a captures/shown-based
  calc would suggest; waiting longer was never going to resolve this on the
  declared primary metric, by a wide margin.
- **What actually justifies the decision:** absolute weekly count of UNIQUE
  PEOPLE who dismissed the modal at least once (not raw dismissal events —
  the underlying analyzer deduped per-person before counting:
  "People counts, not event counts" per its own comment). Cumulative:
  control ≈200 unique dismissers/wk (1,598/55.77 days), cold-start ≈102/wk
  (811/55.77 days) — roughly HALF as many distinct people got interrupted,
  for a capture count that is a statistical wash. This does NOT prove total
  raw interruption *events* fell by the same ratio (a person can dismiss,
  wait out the 14-day cooldown, and be re-shown — that repeat-event rate
  isn't captured here), but distinct-people-interrupted is itself a
  reasonable proxy for the thing the original 2026-07-20 motivation cared
  about (60-66% dismissal, zero conversion gain from two prior fixes).
- **Open, unresolved caveat:** per-shown dismissal rate is WORSE for
  cold-start (77.0% vs control's 60.9%) — the visitors who do still get
  shown the modal in the cold-start arm dismiss it more often, not less.
  This could be a trigger-mix composition effect (the page-view filter
  changes which of exit_intent/scroll_depth/return_visitor make up the
  "shown" population, and those triggers may carry different baseline
  dismiss rates) rather than a true per-visitor regression, but this was not
  investigated further with a trigger-stratified breakdown before
  concluding — flagged here for anyone revisiting this decision, not treated
  as blocking. **Record this decision honestly:** "substantially fewer
  interruptions, uncertain signup cost, accepted as a product preference" —
  not "cold-start converts better" or "guardrails passed, therefore
  proven safe." Neither of those two framings survived review.

**What changed in code:** `getColdStartArm`/`coldStartCheckApplies`/
`COLD_START_FLAG` deleted from `src/lib/gate-logic.ts`; the flag-poll and
arm-conditional branch removed from `src/contexts/ProGateContext.tsx`
(`hasSeenEnoughPages` now gates unconditionally); the `gate-cold-start`
entry removed from `scripts/lib/flag-registry.js`; the monitor/analyzer/
diagnostic scripts and their tests deleted
(`monitor-gate-cold-start.js`, `analyze-gate-cold-start.js`,
`diagnose-gate-cold-start-join.js`, `gate-cold-start-rules.js` + test,
`diagnose-gate-cold-start-join.yml`); `monitor-gate-ab.yml`'s gate-cold-start
step removed. The PostHog flag itself (id 772232) was archived (`active:
false`, not deleted, for reproducibility) via `.github/workflows/manual-
posthog-flag-archive.yml` — built and dispatched by the BRO-3459 follow-up
(2026-09-15, run 35027111711, succeeded) after no session at teardown time
had `POSTHOG_PERSONAL_API_KEY` available locally to do it directly. This
document is kept in place as the reproducibility record.

**Rollback:** flipping the PostHog flag does NOTHING now — enforcement is
unconditional in code, not flag-gated. Reverting to pre-teardown (arm-split)
behavior requires a code change (restore `getColdStartArm`/
`coldStartCheckApplies`/`COLD_START_FLAG` from git history, e.g. `git show
<pre-teardown-sha>:src/lib/gate-logic.ts`) plus a normal deploy via
`.github/workflows/vercel-deploy.yml`. Reverting to pre-2026-07-20 (no
minimum at all, for everyone) just means deleting the unconditional
`hasSeenEnoughPages` guard in `ProGateContext.triggerGate` — no flag
involved either way.
