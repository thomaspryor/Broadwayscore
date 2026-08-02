'use strict';

/**
 * arm-registry.js — the pipeline "arms" whose cross-run yield is tracked in
 * data/audit/arm-yield-ledger.jsonl and judged by scripts/check-arm-yield.js.
 *
 * Card #647. An "arm" is any independently-schedulable producer whose silence
 * is meaningful. Two kinds, because the two have different observable output:
 *
 *   kind: 'workflow' — yield for a day = the number of runs of that workflow
 *     that CONCLUDED SUCCESSFULLY that day. This is deliberately not the same
 *     signal as check-cron-health.yml's CRITICAL_CRONS list:
 *       · cron-health asks "how many hours since the last success?" against a
 *         hand-maintained per-cron `max_hours` constant. Every arm added there
 *         needs a human to pick a number, and an arm nobody remembered to add
 *         is invisible (2 workflows had NEVER executed once — task #737).
 *       · this asks "how long has this gone without producing, relative to how
 *         long it has EVER gone without producing?" The cadence is learned from
 *         the arm's own history, so a monthly cron gets a monthly tolerance and
 *         an hourly cron a tight one, with no constant to maintain or drift.
 *     It also catches the shape that defeated all three arms in the 2026-07-30
 *     audit: conclusion=cancelled (orchestrator, killed at its 360min cap) and
 *     conclusion=failure with email:false notification (sweep-we-aggregators)
 *     both count as ZERO yield here, because neither produced anything.
 *
 *   kind: 'outlet' — yield for a day = review-text files for those outletIds
 *     whose textFetchedAt/classifiedAt lands on that day. This is true ITEM
 *     yield: the thing the pipeline exists to produce. A workflow can run green
 *     every day and still have stopped producing (a dead extractor, an expired
 *     cookie, a scraper silently returning empty pages) — NY Post and Hollywood
 *     Reporter went three months without a single collected review while every
 *     workflow around them stayed green (task #582).
 *
 * Adding an arm: add the entry, then backfill its history so the detector has
 * a cadence to learn from before it can judge anything —
 *   node scripts/record-arm-yield.js --backfill-days=60 --arms=<id>
 * An arm with fewer than DEFAULTS.minProductiveDays productive days in its
 * baseline window reports 'insufficient-history' and never alerts, so a newly
 * added arm cannot page anyone on day one.
 */

const ARMS = [
  // ── The three arms found dead by the 2026-07-30 pipeline health audit ─────
  {
    id: 'workflow:opening-night-orchestrator',
    label: 'Opening Night Orchestrator',
    kind: 'workflow',
    cadence: 'steady',
    workflow: 'opening-night-orchestrator.yml',
    // Dead 2026-07-19 → 07-30: 166 of 197 runs hit the 360min cap and were
    // CANCELLED, so `if: always()` never fired and its own alerting never ran.
  },
  {
    id: 'workflow:sweep-we-aggregators',
    label: 'Sweep WE Aggregators',
    kind: 'workflow',
    cadence: 'steady',
    workflow: 'sweep-we-aggregators.yml',
    // Dead 2026-07-17 → 08-02: 8 consecutive failures notified at
    // severity:low / email:false, i.e. no owner-visible signal for 16 days.
  },
  {
    id: 'workflow:scoring-audit',
    label: 'Scoring Audit',
    kind: 'workflow',
    cadence: 'steady',
    workflow: 'scoring-audit.yml',
    // Dead since 2026-03-01: 5/5 failures on a MONTHLY cron — five data points
    // in five months. The learned threshold is what makes a monthly arm
    // judgeable at all without hand-picking a ~750h constant.
  },

  // ── Review-collection workflows: silence here means no reviews collected ──
  {
    id: 'workflow:collect-we-ob-reviews',
    label: 'Collect WE/OB Reviews',
    kind: 'workflow',
    cadence: 'steady',
    workflow: 'collect-we-ob-reviews.yml',
  },
  {
    id: 'workflow:collect-review-texts',
    label: 'Collect Review Texts',
    kind: 'workflow',
    cadence: 'steady',
    workflow: 'collect-review-texts.yml',
  },
  {
    id: 'workflow:outlet-listing-poller',
    label: 'Outlet Listing Poller',
    kind: 'workflow',
    cadence: 'steady',
    workflow: 'outlet-listing-poller.yml',
  },
  {
    id: 'workflow:scrape-westendtheatre',
    label: 'Scrape WestEndTheatre',
    kind: 'workflow',
    cadence: 'steady',
    workflow: 'scrape-westendtheatre.yml',
  },

  // ── Outlet arms: TRUE item yield, the signal a green workflow can't give ──
  // Chosen as the outlets whose silence has already cost the site real scores
  // (#582 NY Post / Hollywood Reporter, #280 Newsday) plus the highest-volume
  // Broadway/West End producers, where a dead extractor is most expensive.
  { id: 'outlet:nytimes', label: 'New York Times (reviews collected)', kind: 'outlet', outletIds: ['nytimes'] },
  { id: 'outlet:broadwayworld', label: 'BroadwayWorld (reviews collected)', kind: 'outlet', outletIds: ['broadwayworld'] },
  { id: 'outlet:variety', label: 'Variety (reviews collected)', kind: 'outlet', outletIds: ['variety'] },
  { id: 'outlet:nypost', label: 'New York Post (reviews collected)', kind: 'outlet', outletIds: ['nypost'] },
  { id: 'outlet:hollywood-reporter', label: 'Hollywood Reporter (reviews collected)', kind: 'outlet', outletIds: ['hollywood-reporter'] },
  { id: 'outlet:newsday', label: 'Newsday (reviews collected)', kind: 'outlet', outletIds: ['newsday'] },
  { id: 'outlet:theatermania', label: 'TheaterMania (reviews collected)', kind: 'outlet', outletIds: ['theatermania'] },
  { id: 'outlet:whatsonstage', label: 'WhatsOnStage (reviews collected)', kind: 'outlet', outletIds: ['whatsonstage'] },
  { id: 'outlet:guardian', label: 'The Guardian (reviews collected)', kind: 'outlet', outletIds: ['guardian'] },
  { id: 'outlet:times-uk', label: 'The Times UK (reviews collected)', kind: 'outlet', outletIds: ['times-uk'] },
  // Deliberately included as the sparse-arm control: nysr published nothing for
  // 8 consecutive days in July 2026 while perfectly healthy. Any detector that
  // pages on this arm's normal rhythm is mis-tuned, and having it registered
  // means that mis-tuning shows up immediately instead of in the owner's inbox.
  { id: 'outlet:nysr', label: 'New York Stage Review (reviews collected)', kind: 'outlet', outletIds: ['nysr'] },
];

const ARMS_BY_ID = new Map(ARMS.map((a) => [a.id, a]));

/** @returns {Array<object>} arms of the given kind ('workflow' | 'outlet'). */
function armsOfKind(kind) {
  return ARMS.filter((a) => a.kind === kind);
}

/**
 * Resolve a --arms=a,b filter to registry entries.
 * @param {string|null|undefined} csv
 * @returns {{arms: Array<object>, unknown: Array<string>}}
 */
function selectArms(csv) {
  if (!csv) return { arms: ARMS, unknown: [] };
  const wanted = String(csv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const arms = [];
  const unknown = [];
  for (const id of wanted) {
    if (ARMS_BY_ID.has(id)) arms.push(ARMS_BY_ID.get(id));
    else unknown.push(id);
  }
  return { arms, unknown };
}

module.exports = { ARMS, ARMS_BY_ID, armsOfKind, selectArms };
