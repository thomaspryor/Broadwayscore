/**
 * email-gate-funnel-rules.js — pure decision rules for the weekly OVERALL
 * email-gate funnel monitor (scripts/monitor-email-gate-funnel.js, card #240).
 *
 * Input: the --json summary from analyze-email-gate-funnel.js (7d, modal-only,
 * real users) + persisted state. Output: alerts to send + new state. No I/O
 * here (CLAUDE.md §15 test-extraction pattern).
 *
 * PRIMARY guardrail: ABSOLUTE captures/week vs the pre-cold-start-gate baseline
 * (~0.93/day, ~6.5/wk, P0 Jun15-Jul12). The cold-start gate (live 2026-07-20
 * 16:37 UTC) is projected to cut impressions ~85-90% and lift conversion RATE
 * ~5-8x by pure selection — a rate-only threshold would look like a win while
 * list growth actually collapses. Alert threshold ~1 capture/wk: below that,
 * the 66%-converter-retention estimate behind the gate's design was likely
 * wrong and a revert should be considered.
 *
 * MIN_IMPRESSIONS_FOR_ALERT guards against judging collapse off a near-empty
 * ramp-up window (e.g. 21 shown in the first 7.5h post-launch) — wait for a
 * week with real gate traffic before treating a low capture count as signal.
 *
 * Full analysis: ~/Documents/claude-outputs/email-gate-analysis-2026-07-20.md
 */

const BASELINE_CAPTURES_PER_DAY = 0.93;
const ALERT_CAPTURES_PER_WEEK = 1;
const MIN_IMPRESSIONS_FOR_ALERT = 30;
// Just under 7d so a weekly cron always re-alerts while the collapse persists,
// but a same-week manual re-run (dry-run debugging, retry) doesn't double-send.
const COLLAPSE_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * @param {object} summary  --json output of analyze-email-gate-funnel.js
 * @param {object} state    persisted monitor state (may be {})
 * @param {number} nowMs    Date.now()
 * @returns {{ alerts: Array<{kind:string,severity:string,email:boolean,title:string,description:string}>, state: object }}
 */
function decideEmailGateFunnelAlerts(summary = {}, state = {}, nowMs = 0) {
  const next = { ...state };
  const alerts = [];

  const impressions = summary.impressions || 0;
  const capturesPerWeek = typeof summary.capturesPerWeek === 'number' ? summary.capturesPerWeek : (summary.captured || 0);
  const baselinePerWeek = +(BASELINE_CAPTURES_PER_DAY * 7).toFixed(1);

  const belowFloor = impressions >= MIN_IMPRESSIONS_FOR_ALERT && capturesPerWeek < ALERT_CAPTURES_PER_WEEK;
  const cooled = !next.lastCollapseAlertAt || nowMs - next.lastCollapseAlertAt >= COLLAPSE_COOLDOWN_MS;

  if (belowFloor && cooled) {
    next.lastCollapseAlertAt = nowMs;
    alerts.push({
      kind: 'capture-collapse', severity: 'error', email: true, stampKey: 'lastCollapseAlertAt',
      title: 'Email gate: absolute captures/week collapsed',
      description: `Modal-only captures/week (${capturesPerWeek}) is below the ${ALERT_CAPTURES_PER_WEEK}/wk floor ` +
        `(baseline ${BASELINE_CAPTURES_PER_DAY}/day pre-cold-start-gate, ~${baselinePerWeek}/wk). ` +
        `${impressions} impressions, ${summary.dismissRatePct ?? '–'}% dismissed, ${summary.convRatePct ?? '–'}% conv/impression this window. ` +
        `The gate's 66%-converter-retention estimate may be wrong — consider reverting the cold-start gate. ` +
        `See ~/Documents/claude-outputs/email-gate-analysis-2026-07-20.md.`,
    });
  } else if (impressions < MIN_IMPRESSIONS_FOR_ALERT) {
    alerts.push({
      kind: 'ramp-up', severity: 'warning', email: false, logOnly: true,
      title: 'Email gate funnel: still ramping up',
      description: `Only ${impressions} impressions this window (below the ${MIN_IMPRESSIONS_FOR_ALERT}-impression floor) — ` +
        `too early to judge captures/week. Captures so far: ${summary.captured ?? 0}.`,
    });
  }

  alerts.push({
    kind: 'weekly-summary', severity: 'warning', email: false, logOnly: true,
    title: 'Email gate funnel — weekly summary',
    description: `impressions ${impressions} (expect ~90-120/wk post-cold-start-gate, was ~950/wk pre) · ` +
      `dismissed ${summary.dismissRatePct ?? '–'}% · captured ${summary.captured ?? 0} people / ${summary.capturedEvents ?? 0} events ` +
      `(${summary.convRatePct ?? '–'}% conv/impression) · captures/wk ${capturesPerWeek} vs baseline ~${baselinePerWeek}/wk · ` +
      `mobile bounce ${summary.mobileBouncePct ?? '–'}%.`,
  });

  return { alerts, state: next };
}

module.exports = {
  decideEmailGateFunnelAlerts,
  BASELINE_CAPTURES_PER_DAY,
  ALERT_CAPTURES_PER_WEEK,
  MIN_IMPRESSIONS_FOR_ALERT,
};
