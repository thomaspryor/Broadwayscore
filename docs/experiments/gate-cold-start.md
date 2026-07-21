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
- **Canonical readout**: `node scripts/analyze-gate-cold-start.js`
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

- **Flag health**: exists, active, 50/50 split, 100% rollout. Anything else
  means the experiment isn't running as designed and any numbers read during
  the broken window are contaminated. Read via `node
  scripts/analyze-gate-cold-start.js` (per-experiment) or the generic weekly
  `scripts/monitor-flag-parity.js` (card #250).
- **Guardrail — capture collapse**: combined modal captures/week < 1 for 2
  CONSECUTIVE meaningful weeks (baseline ~4/wk pre-experiment) is grounds to
  consider reverting the cold-start gate.
- **Guardrail — impression split**: control:cold-start shown should stay
  roughly 10:1 (the 2-page minimum suppresses treatment impressions by
  selection). Drift toward parity means the treatment filter silently
  stopped applying, not that "it's working."
- **Primary judgment**: minimum 4 weeks (28 days) of experiment runtime
  before reading the ITT primary metric. `scripts/monitor-gate-cold-start.js`
  fires a one-time "time to look" nudge at that milestone — it never judges
  the primary itself.

## Full decision logic

Pure, testable, and the actual source of truth for the numbers above:
`scripts/lib/gate-cold-start-rules.js` (guardrail thresholds + alerting) and
`scripts/analyze-gate-cold-start.js` (attribution + metric computation).
