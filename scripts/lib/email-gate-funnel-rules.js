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
 * Two secondary guardrails close gaps a hard <1/wk floor alone would miss
 * (both found in adversarial review, 2026-07-20):
 *   - funnel-stalled: if impressions EVER reached the floor and then drop
 *     back below it, that's not "still ramping up" — the modal stopped
 *     rendering or an instrumentation rename broke event tracking. Silently
 *     logging "ramp-up" forever would hide a real outage.
 *   - sustained-decline: a steady 2-3/wk (below half the baseline, but never
 *     individually dipping under the hard floor) never trips capture-collapse
 *     on any single week. Tracks a short rolling history to catch the trend.
 *
 * Full analysis: ~/Documents/claude-outputs/email-gate-analysis-2026-07-20.md
 */

const BASELINE_CAPTURES_PER_DAY = 0.93;
const ALERT_CAPTURES_PER_WEEK = 1;
const MIN_IMPRESSIONS_FOR_ALERT = 30;
const SUSTAINED_DECLINE_WEEKS = 3;
const SUSTAINED_DECLINE_THRESHOLD = 3; // roughly half the ~6.5/wk baseline
// Just under 7d so a weekly cron always re-alerts while a problem persists,
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
  const hasMeaningfulTraffic = impressions >= MIN_IMPRESSIONS_FOR_ALERT;

  // Factual, never reverted: has the funnel ever produced a meaningful week?
  const everReachedFloor = !!next.everReachedFloor;
  if (hasMeaningfulTraffic) next.everReachedFloor = true;

  const belowFloor = hasMeaningfulTraffic && capturesPerWeek < ALERT_CAPTURES_PER_WEEK;
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
  } else if (!hasMeaningfulTraffic) {
    if (everReachedFloor) {
      // The funnel WAS producing meaningful traffic and just fell below the
      // floor — not ramp-up, a regression. Actionable, not log-only.
      const stalledCooled = !next.lastStalledAlertAt || nowMs - next.lastStalledAlertAt >= COLLAPSE_COOLDOWN_MS;
      if (stalledCooled) {
        next.lastStalledAlertAt = nowMs;
        alerts.push({
          kind: 'funnel-stalled', severity: 'error', email: true, stampKey: 'lastStalledAlertAt',
          title: 'Email gate funnel: impressions collapsed',
          description: `Only ${impressions} gate impressions this window, down from a previously-healthy level ` +
            `(below the ${MIN_IMPRESSIONS_FOR_ALERT}-impression floor). This funnel was working before — check ` +
            `whether the modal still renders and whether gate_modal_shown/email_captured events are still firing ` +
            `in PostHog (node scripts/analyze-email-gate-funnel.js), not just conversion rate.`,
        });
      }
    } else {
      alerts.push({
        kind: 'ramp-up', severity: 'warning', email: false, logOnly: true,
        title: 'Email gate funnel: still ramping up',
        description: `Only ${impressions} impressions this window (below the ${MIN_IMPRESSIONS_FOR_ALERT}-impression floor) — ` +
          `too early to judge captures/week. Captures so far: ${summary.captured ?? 0}.`,
      });
    }
  }

  // Sustained multi-week decline: only meaningful weeks count, so a stall
  // doesn't masquerade as "3 low weeks" — funnel-stalled already covers that.
  // A non-meaningful (ramp-up/gap) week must RESET the rolling history, not
  // leave it untouched — otherwise low/low/gap/low reads as "3 consecutive
  // low weeks" even though the gap week sits between them (2026-07-21
  // adversarial review caught the identical bug in gate-cold-start-rules.js's
  // capture-collapse streak counter; this is the same pattern here).
  if (hasMeaningfulTraffic) {
    next.recentCaptures = [...(next.recentCaptures || []), capturesPerWeek].slice(-SUSTAINED_DECLINE_WEEKS);
    if (
      next.recentCaptures.length === SUSTAINED_DECLINE_WEEKS
      && next.recentCaptures.every((v) => v >= ALERT_CAPTURES_PER_WEEK && v < SUSTAINED_DECLINE_THRESHOLD)
    ) {
      const declineCooled = !next.lastDeclineAlertAt || nowMs - next.lastDeclineAlertAt >= COLLAPSE_COOLDOWN_MS;
      if (declineCooled) {
        next.lastDeclineAlertAt = nowMs;
        alerts.push({
          kind: 'sustained-decline', severity: 'error', email: true, stampKey: 'lastDeclineAlertAt',
          title: 'Email gate funnel: sustained multi-week decline',
          description: `Captures/wk for the last ${SUSTAINED_DECLINE_WEEKS} weeks: ${next.recentCaptures.join(', ')} — ` +
            `each stayed above the hard ${ALERT_CAPTURES_PER_WEEK}/wk collapse floor but all are below half the ` +
            `~${baselinePerWeek}/wk baseline. List growth is fading gradually rather than collapsing outright.`,
        });
      }
    }
  } else {
    next.recentCaptures = [];
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
  SUSTAINED_DECLINE_WEEKS,
  SUSTAINED_DECLINE_THRESHOLD,
};
