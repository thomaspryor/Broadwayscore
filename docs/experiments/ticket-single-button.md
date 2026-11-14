# Experiment: ticket-single-button

Setup contract for any new experiment: [`README.md`](./README.md).

**Retroactive doc — BRO-3456.** This experiment predates the pre-registration
contract in `README.md` (its current run started 2026-04-11; the contract
was written 2026-07-20/24 alongside card #250/#392). `ownerDoc` in
`scripts/lib/flag-registry.js` was `null` until this audit. Everything below
step "History" is reconstructed after the fact from git history and
committed monitor state, not decided blind before looking at data — treat
the "Pre-registered rules" section as best-effort reconstruction of intent,
not a true pre-registration.

## What's being tested

Single ticket-purchase CTA button vs. the existing multi-platform button
row — does consolidating to one button change click-through/conversion?

- **Flag key**: `ticket-single-button` (PostHog, project 332742)
- **Variants**: `multi` (50%) / `single` (50%), 100% rollout,
  `ensure_experience_continuity: true`
- **Client**: `src/components/TicketButtonsAB.tsx`
- **Registry entry**: `scripts/lib/flag-registry.js` (`REGISTERED_FLAGS`)
- **Canonical readout**: `node scripts/analyze-ab-test.js` (default flag;
  `--days N` for window size, `--json` for the machine-readable summary the
  monitor consumes)
- **Weekly automated monitor**: `scripts/monitor-ticket-ab.js` (card #392),
  wired into `monitor-gate-ab.yml`
- **Weekly flag-parity guardrail**: `scripts/monitor-flag-parity.js` (card
  #250 — generic, covers every registered flag including this one)

## Primary metric

Per-variant conversion rate = unique converting users (Impact `SubId1`,
deduped) / unique clicking users (PostHog `distinct_id` on `ticket_click`
events, `page_type=show`, valid non-fallback `ab_variant`), compared via
two-tailed two-proportion z-test (`scripts/lib/significance.js`).

## History

- **2026-03-28**: first run of this test starts.
- **2026-04-09**: `TicketButtonsAB.tsx` + flag shipped (`636684616dd`).
- **2026-04-11 19:00 UTC — restart** (`14878d6ae8b`, and
  `FLAG_RESTART_DATES` in `analyze-ab-test.js`): the first run (Mar 28–Apr
  11) was invalidated by a StubHub-hide change mid-flight altering the
  `multi` condition, plus a sticky-bucket gap during the flag flip. Fresh
  clock, 50/50 split. **This is the only restart this flag has ever had** —
  see "Restart clarification" below.
- **2026-04-27**: postback attribution ship-check fixes (`14c8be732f4`) —
  `affiliate-utils.ts` began forwarding `distinct_id` (SubId1) and
  `ab_variant` with a `flag:ticket-single-button` cohort prefix (SubId2) on
  every Impact click URL, so conversions can be joined back to a variant.
- **2026-07-20**: flag-parity guardrail ships (card #250, `763d3ad9eda`).
- **2026-07-24**: weekly result monitor ships (card #392, `6de391f7f69`),
  same day as two fixes in the same PR set: the analyzer's inline `zTest()`
  had been printing `p-value: NaN` on every run (clicks passed into
  conversion-count slots, `6a5c46e6f89`), and ship-check hardening added the
  independence/flag-health/conversion-floor/asymmetric-zero guards now in
  `significance.js` / `computeAbSignificance` (`d2041c5aea9`).
- **2026-07-27 — first monitor run, 3 days after launch**: window
  2026-07-13→07-27, **p = 0.0158, significant = true, not flagged
  underpowered** (multi: 52 users / 9 converters = 17.3%; single: 46 users /
  18 converters = 39.1%). This tripped the monitor's one-time
  `significance-reached` alert (`significanceAlertedAt` stamped; the rule
  fires once ever, by design — see `ticket-ab-monitor-rules.js`).
- **2026-08-04 through 2026-09-14 — seven more weekly reads, all
  non-significant**, and the single-vs-multi gap that drove the 07-27 read
  never reproduces at anywhere near the same size (see table below). The
  most recent read (09-14) is flagged underpowered again (3 converting users
  in `multi`).

| window (14d)      | multi users/conv (rate) | single users/conv (rate) | p      | sig | underpowered |
|--------------------|--------------------------|----------------------------|--------|-----|--------------|
| 07-13 → 07-27      | 52/9 (17.3%)             | 46/18 (39.1%)              | 0.0158 | **yes** | no |
| 07-21 → 08-04      | 52/7 (13.5%)             | 64/8 (12.5%)               | 0.8780 | no  | no |
| 07-27 → 08-10      | 51/9 (17.6%)             | 44/6 (13.6%)               | 0.5929 | no  | no |
| 08-03 → 08-17      | 47/8 (17.0%)             | 52/11 (21.2%)              | 0.6021 | no  | no |
| 08-10 → 08-24      | 42/6 (14.3%)             | 53/11 (20.8%)              | 0.4140 | no  | no |
| 08-18 → 09-01      | 42/8 (19.0%)             | 48/10 (20.8%)              | 0.8327 | no  | no |
| 08-24 → 09-07      | 38/6 (15.8%)             | 48/6 (12.5%)               | 0.6620 | no  | no |
| 08-31 → 09-14      | 53/3 (5.7%)              | 50/7 (14.0%)               | 0.1531 | no  | **yes** |

(source: `git log -p -- data/audit/ticket-ab-monitor-state.json`, 8 commits,
2026-07-27 through 2026-09-14)

## Restart clarification (this audit's main finding)

The ticket that opened this audit read `lastSummary.startDate` in
`data/audit/ticket-ab-monitor-state.json` moving from `2026-08-24` to
`2026-08-31` between two commits and read it as "the experiment restarted
2026-08-31." **It did not restart.** `startDate` in that file is the rolling
14-day analysis window's start boundary (`endDate − 14 days`), recomputed
fresh on every weekly run — it is expected to advance by about a week each
time the monitor runs, exactly as the table above shows for all eight
readings. `restartClamped: false` on every one of those eight commits
confirms the window never even reached back far enough to hit the real
restart marker (`FLAG_RESTART_DATES['ticket-single-button'] =
2026-04-11T19:00:00Z` in `analyze-ab-test.js`) — the true restart is over
four months before the earliest of these readings. There is exactly one
restart in this flag's history, and it is not the cause of the current
underpowered state.

## Is this the same trap as gate-cold-start (BRO-3422)?

Same *shape* (a monitor nudges once, nobody records a decision, the state
keeps rolling with no conclusion), different *mechanism*:

- **gate-cold-start's** problem was a real-but-tiny effect: a rigorous
  cumulative read across the whole runtime showed the gap was real but so
  small that reaching 80% power would take ~666 days — waiting longer could
  never resolve it on the pre-registered primary metric.
- **ticket-single-button** has never had a cumulative read at all. Every
  number in the table above is a fresh, independent 14-day rolling window —
  overlapping with its neighbor by ~7 days, but never accumulating across
  the full ~5-month run since the 2026-04-11 restart. The one "significant"
  result was the very first window the brand-new monitor happened to look
  at (3 days after the monitor + a NaN-bug fix shipped), and none of the
  seven readings since reproduce a gap anywhere near that size — it reads as
  a chance extreme value on a small window (multi=52, single=46 users),
  not a durable effect. Because the monitor's significance alert fires only
  once ever (`!next.significanceAlertedAt` guard in
  `ticket-ab-monitor-rules.js`), it will never re-nudge even if a later
  window becomes significant again — and there is no code path anywhere in
  this pipeline that computes a single cumulative-since-restart number the
  way `analyze-gate-cold-start.js --days=60` did for the other experiment.

**Net: this is not "wait longer, resolvable given enough time" so much as
"the tool this monitor runs cannot currently produce the number that would
resolve it."** A 14-day rolling window at this traffic level is underpowered
by construction; only a full cumulative read (or a decision on a different
metric) can conclude it.

## Power calculation

Two-proportion power (`n = (z_{α/2} + z_β)² · [p₁(1−p₁) + p₂(1−p₂)] / (p₁−p₂)²`,
z₀.₀₅/₂=1.96, z₀.₈₀=0.84 — same method used for gate-cold-start), estimated
from the committed rolling-window snapshots since no cumulative pull was
available locally (no `POSTHOG_PERSONAL_API_KEY` in this environment — see
"Data limitation" below):

- **Excluding the 07-27 outlier window** (pooling the other 7): multi
  14.5% (47/325 users), single 16.4% (59/359 users), gap 1.9pp. Required
  n ≈ 5,270/arm. At ~3.4–3.6 users/variant/day (observed average), that's
  **roughly 4+ years** at current traffic.
- **Including the 07-27 window** (pooling all 8, i.e. treating the one
  significant read as part of the true rate rather than noise): multi
  14.9% (56/377), single 19.0% (77/405), gap 4.2pp. Required n ≈ 1,280/arm
  ≈ **roughly 1 year**.

Either estimate puts a clean resolution well outside any reasonable
planning horizon for a rolling 14-day window, and the true answer is
probably closer to the first estimate (the 07-27 window is the one that
never repeated).

**Data limitation**: this doc's numbers come entirely from the 8 committed
JSON snapshots in `data/audit/ticket-ab-monitor-state.json`'s git history —
this environment had `IMPACT_ACCOUNT_SID`/`IMPACT_AUTH_TOKEN` but not
`POSTHOG_PERSONAL_API_KEY`, so a fresh live pull or a true
cumulative-since-2026-04-11 read (which `analyze-ab-test.js` does not
support today — it only ever computes `now − N days`, clamped no earlier
than the restart) was not possible from here. Re-run
`node scripts/analyze-ab-test.js --days 90` (or larger) from a session with
PostHog access for a fresher, wider single-window read; note the Impact
Actions API caps `StartDate`/`EndDate` at 45 days apart per this script's
own header comment, so a true 5-month cumulative read needs either a
chunked query (summing per-period Action counts) or an equivalent HogQL
cumulative query against PostHog directly, whichever is cheaper to build —
neither exists yet.

## Recommendation (owner decision needed — not made by this audit)

Same framing gate-cold-start converged on: **decide on a guardrail or
business metric now, rather than waiting for the rolling-window primary to
resolve on its own — at current traffic it structurally can't, within a
useful timeframe, on the tool as it exists today.** Options for the owner:

1. **Build the missing cumulative-since-restart read** (chunked Impact
   query or a HogQL-based PostHog aggregate spanning 2026-04-11 to now) as
   this experiment's one canonical number, replacing "whatever the rolling
   14-day window says this week" as the thing anyone reads. This is real
   engineering work on a revenue-bearing pipeline (CLAUDE.md §18 applies to
   `scripts/lib/**` and monitor infra) — flagging as a follow-up, not
   building blind/untested here.
2. **Decide on the secondary business metric already being collected**:
   `analyze-ab-test.js` already computes direct commission/revenue per
   variant from Impact (see "Direct commission (subId2)" in its prose
   output) — a revenue/commission comparison sidesteps the underpowered
   conversion-rate primary the same way gate-cold-start's distinct-people
   metric did.
3. **Accept no measurable difference and pick a design on product/UX
   grounds** — the null result here (7 of 8 windows, and the pooled
   excluding-outlier estimate) is a legitimate "we can't tell them apart on
   this metric" outcome, not a data gap.

This audit does not recommend one of these three — that's the "owner
judgment" this ticket's acceptance criteria calls for, not something to
guess from git history.

## What changed from this audit

- `scripts/lib/flag-registry.js`: `ownerDoc` for `ticket-single-button` set
  to this file (was `null`) — the gap that let this experiment run 5 months
  with a working flag and, until card #392, no result monitor, and until
  now, no doc at all.
- No experiment behavior, flag rollout, or business decision changed. Per
  `memory/feedback_ab_test_guardrails.md` rule 1 and this ticket's own
  acceptance criteria, that stays an owner call.

## Conclusion (2026-09-16)

**Decision: keep the single-button design permanently. A/B retired,
flag archived.** Owner picked single on UX/maintenance grounds (BRO-3456)
after Option 2 above (the revenue metric) was actually pulled and analyzed
this same day — not left as a follow-up.

**What the revenue pull found, and why it changed twice in one session:**

1. First pass: pulled live Impact Actions.json cumulative since the true
   2026-04-11 restart (chunked into ≤44-day windows, summed by the
   `buttons:` segment of `SubId2`). Raw totals: single 142 conversions /
   $622.52 commission; multi 99 conversions / $757.97 commission — looked
   like a real 17.9% multi advantage (conversion-level Welch t=-3.07,
   p=0.0022).
2. That test was invalid: the 142 single-arm conversions came from only 75
   unique users — conversions aren't independent, users are the
   randomization unit. Redone at the **user level** (an Opus review caught
   this and re-ran it): single **$8.30/user**, multi **$10.83/user**,
   p=0.119, 95% CI **[-$5.71, +$0.65]** — crosses zero, not significant.
   Cluster bootstrap on total commission: 95% CI [-$362, +$86], Pr(single
   ahead) = 12%. Converting-user counts: 75 vs 70, p≈0.68 — also not
   significant.
3. **Root cause of the illusion**: TodayTix pays two commission tiers
   (~1% and ~4-5%). One single-arm user alone made 10 purchases across 5
   July days at the low tier — a whale who happened to land in that
   bucket by randomization luck, not a button-design effect. High-tier
   share was 25.0% (single) vs 50.5% (multi), z=-3.96 — a real difference,
   but a property of which users each arm happened to draw, not of what
   the arm showed them.
4. No platform confound: both arms were 100% `platform:todaytix` in the
   attributed data (the separate `ticket-primary-platform` experiment is
   already concluded/pinned 100% todaytix), so the commission-tier mix
   isn't explained by which platform a click routed to either.

**Net: 5 months and ~$51k in tracked Impact revenue found no user-level
difference in conversion rate, converting-user count, or commission
between the two designs.** Building the missing cumulative click-read
(option 1 above) is not worth it — its money-layer equivalent just ran and
is also null, and the minimum detectable effect at this variance (~$5/user
against an observed $2.53/user gap) means more data collection wouldn't
resolve it either.

**What changed in code (BRO-3456 follow-up implementation, 2026-09-16):**
`src/components/TicketButtonsAB.tsx` — removed the `ticket-single-button`
flag read/poll and the entire multi-button code path (secondary platform
links, the inline Official-Site link, the `maxButtons` prop); only the
primary CTA renders now, unconditionally. `ticket-primary-platform` is
untouched. `ticket-single-button` entry removed from
`scripts/lib/flag-registry.js` (deleted outright, matching gate-cold-start's
precedent, not marked `exists:false`). Deleted
`scripts/monitor-ticket-ab.js`, `scripts/lib/ticket-ab-monitor-rules.js` +
test, `scripts/validate-ab-test.js` — no purpose once the A/B is retired.
`.github/workflows/monitor-gate-ab.yml`'s ticket-single-button monitor step
removed. The PostHog flag (`ticket-single-button`) was archived
(`active: false`, not deleted, for reproducibility) via
`scripts/posthog-flag-admin.js` / `.github/workflows/manual-posthog-flag-archive.yml`
(the tool BRO-3459 built earlier the same day specifically so this
teardown wouldn't have to leave the flag live-but-unread the way
gate-cold-start's initially did).

**Rollback:** reverting to the arm-split behavior needs a code change
(restore the deleted flag-read/branching from git history) plus a normal
deploy — flipping the archived PostHog flag back to active does nothing on
its own, since enforcement is no longer flag-gated.

**Known limitation (Codex ship-check finding, not fixed — accepted as-is):**
`TicketButtonsAB.tsx`'s tracking string is permanently namespaced
`flag:ticket-single-button,platform:...,buttons:single` (kept that way so
`scripts/analyze-ab-test.js`'s default invocation keeps matching real
events — see that file's header comment). There is no experiment-end
cutoff analogous to `FLAG_RESTART_DATES`, so `analyze-ab-test.js --flag
ticket-single-button` run today (or years from now) mixes genuine
2026-04-11–09-16 randomized-trial clicks with every post-conclusion click,
which are no longer randomized (100% single, by design). A historical
re-read of the trial itself must filter to `EventDate <
2026-09-16T16:00:00Z`-ish manually; the analyzer does not do this for you.
Building a proper cutoff was judged not worth it for a concluded,
permanent-single-button surface — flagging here so a future session
doesn't mistake "ticket-single-button" for a still-meaningful experiment
name when reading raw Impact/PostHog data outside this doc.

This document is kept in place as the reproducibility record, same as
`docs/experiments/gate-cold-start.md`.
