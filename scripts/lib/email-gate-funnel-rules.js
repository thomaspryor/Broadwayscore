/**
 * email-gate-funnel-rules.js — pure decision rules for the weekly OVERALL
 * email-gate funnel monitor (scripts/monitor-email-gate-funnel.js, card #240).
 *
 * Input: the --json summary from analyze-email-gate-funnel.js (7d, real users)
 * + persisted state. Output: alerts to send + new state. No I/O here
 * (CLAUDE.md §15 test-extraction pattern).
 *
 * PRIMARY guardrail: TOTAL list joins/week (BRO-6371). People join the list
 * three ways: the gate modal (email_captured with a trigger), the inline
 * header/footer forms (email_captured without one), and account sign-in
 * (sign_in_completed; src/lib/auto-subscribe.ts posts straight to Formspree
 * and never fires email_captured). Accounts launched 2026-10-02 and signed-in
 * users never see the modal, so modal-only captures fell to ~3/wk with zero
 * weeks on Poisson noise while total joins grew. Modal-only is now a log line.
 *
 * Baseline: ~35 joins/wk, distinct real-user people across all three channels
 * for the weeks of Oct 5/12/19 2026 (25, 32, 48). Pre-accounts weeks ran 4-10,
 * so a week under ALERT_JOINS_PER_WEEK means sign-in joins mostly stopped
 * (auth broken or sign_in_completed tracking lost), not a slow week.
 *
 * MIN_IMPRESSIONS_FOR_ALERT gates the modal side only: funnel-stalled fires
 * when impressions once reached the floor and then dropped below it (the
 * modal stopped rendering or its events broke). Before the floor was ever
 * reached the modal is in ramp-up; total joins are still judged.
 *
 * sustained-decline catches a steady fade that never trips the hard floor:
 * SUSTAINED_DECLINE_WEEKS consecutive judged weeks under half the baseline.
 *
 * The cold-start gate itself was made permanent 2026-09-15
 * (docs/experiments/gate-cold-start.md, Conclusion); a low week is not a
 * reason to revert it.
 */

const BASELINE_JOINS_PER_WEEK = 35;
const ALERT_JOINS_PER_WEEK = 10;
const MIN_IMPRESSIONS_FOR_ALERT = 30;
const MIN_SIGN_INS_FOR_AUTH_ALERT = 10;
const SUSTAINED_DECLINE_WEEKS = 3;
const SUSTAINED_DECLINE_THRESHOLD = 17; // roughly half the ~35/wk baseline
// Just under 7d so a weekly cron always re-alerts while a problem persists,
// but a same-week manual re-run (dry-run debugging, retry) doesn't double-send.
const COLLAPSE_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
const GATE_DOC = 'docs/experiments/gate-cold-start.md';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
  const modalPerWeek = num(summary.capturesPerWeek) ?? (summary.captured || 0);
  const joinsPerWeek = num(summary.totalJoinsPerWeek) ?? num(summary.totalJoins);
  const hasMeaningfulTraffic = impressions >= MIN_IMPRESSIONS_FOR_ALERT;
  // Old state files carried modal-only history; it is not comparable to joins.
  delete next.recentCaptures;

  // A single confirmed passive opening below the minimum is a regression,
  // even during ramp-up. Legacy events without a count are unknown, not zero.
  const pageViews = summary.pageViewGuardrail;
  if (pageViews?.belowMinimumEvents > 0
    && (!next.lastPageViewMinimumAlertAt || nowMs - next.lastPageViewMinimumAlertAt >= COLLAPSE_COOLDOWN_MS)) {
    next.lastPageViewMinimumAlertAt = nowMs;
    alerts.push({
      kind: 'page-view-minimum', severity: 'error', email: true, stampKey: 'lastPageViewMinimumAlertAt',
      title: 'Email gate: passive modal opened below the page-view minimum',
      description: `${pageViews.belowMinimumEvents} passive gate_modal_shown events opened below the required ` +
        `session page-view minimum (at least 2 pages). Triggers: ${JSON.stringify(pageViews.violationsByTrigger)}. ` +
        `Checked ${pageViews.checkedEvents} events; ${pageViews.unknownPageViewEvents} had missing or invalid counts. ` +
        `Check triggerGate in src/contexts/ProGateContext.tsx and its hasSeenEnoughPages guard. ` +
        `Explicit actions, blocking gates and recapture are exempt.`,
    });
  }

  // Factual, never reverted: has the funnel ever produced a meaningful week?
  const everReachedFloor = !!next.everReachedFloor;
  if (hasMeaningfulTraffic) next.everReachedFloor = true;
  const live = hasMeaningfulTraffic || everReachedFloor;

  if (!hasMeaningfulTraffic && everReachedFloor) {
    // The modal WAS producing meaningful traffic and just fell below the
    // floor: not ramp-up, a regression. Actionable, not log-only.
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
  } else if (!live) {
    alerts.push({
      kind: 'ramp-up', severity: 'warning', email: false, logOnly: true,
      title: 'Email gate funnel: still ramping up',
      description: `Only ${impressions} impressions this window (below the ${MIN_IMPRESSIONS_FOR_ALERT}-impression floor) — ` +
        `too early to judge. Modal captures so far: ${summary.captured ?? 0}.`,
    });
  }

  const channels = `modal ${summary.captured ?? '–'}, inline ${summary.inlineCaptures ?? '–'}, ` +
    `account sign-ins ${summary.signIns ?? '–'}, Formspree auth-auto submissions ${num(summary.formspreeAuthJoins) ?? 'unknown'}`;

  // Sign-in completion fires independently of the Formspree POST. Judge this
  // even during modal ramp-up, without treating an API failure as zero joins.
  if (num(summary.signIns) >= MIN_SIGN_INS_FOR_AUTH_ALERT) {
    const authJoins = num(summary.formspreeAuthJoins);
    const unknown = authJoins === null || authJoins < 0;
    if (unknown || authJoins === 0) {
      const stampKey = unknown ? 'lastAuthJoinsUnknownAlertAt' : 'lastAuthJoinsAlertAt';
      if (!next[stampKey] || nowMs - next[stampKey] >= COLLAPSE_COOLDOWN_MS) {
        next[stampKey] = nowMs;
        alerts.push({
          kind: unknown ? 'auth-joins-unknown' : 'auth-joins-stalled',
          severity: 'error', email: true, stampKey,
          title: unknown ? 'Email list: Formspree sign-in joins could not be verified'
            : 'Email list: sign-ins are not reaching Formspree',
          description: unknown
            ? `${summary.signIns} account sign-ins this window, but Formspree auth-auto submissions are unknown ` +
              `(${summary.formspreeAuthJoinsStatus ?? 'missing'}). Check FORMSPREE_TOKEN (or FORMSPREE_SUBSCRIBER_API_KEY), ` +
              `FORMSPREE_SUBSCRIBER_FORM_ID and the Formspree submissions API. Sign-in events alone do not confirm list joins.`
            : `${summary.signIns} account sign-ins this window, but zero accepted Formspree auth-auto submissions. ` +
              `Check NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID in the site build and the POST in src/lib/auto-subscribe.ts; ` +
              `Formspree may be rejecting posts. sign_in_completed fires even when that POST fails or is skipped.`,
        });
      }
    }
  }

  if (live && joinsPerWeek === null) {
    // An analyzer that stops emitting totals would silently disable the
    // primary guardrail; say so instead of judging off modal-only counts.
    const unknownCooled = !next.lastJoinsUnknownAlertAt || nowMs - next.lastJoinsUnknownAlertAt >= COLLAPSE_COOLDOWN_MS;
    if (unknownCooled) {
      next.lastJoinsUnknownAlertAt = nowMs;
      alerts.push({
        kind: 'joins-unknown', severity: 'error', email: true, stampKey: 'lastJoinsUnknownAlertAt',
        title: 'Email gate monitor: total list joins missing from summary',
        description: 'analyze-email-gate-funnel.js --json returned no totalJoins/totalJoinsPerWeek, so the ' +
          'list-growth guardrail could not run this week. Check the analyzer\'s sign_in_completed and ' +
          'email_captured queries.',
      });
    }
  }

  // Sign-ins do not depend on the modal, so joins are judged whenever the
  // analyzer reports them, even while the gate is in ramp-up or the state
  // file was reset (loadState returns {} on a parse error).
  const judged = joinsPerWeek !== null;
  const cooled = !next.lastCollapseAlertAt || nowMs - next.lastCollapseAlertAt >= COLLAPSE_COOLDOWN_MS;
  if (judged && joinsPerWeek < ALERT_JOINS_PER_WEEK && cooled) {
    next.lastCollapseAlertAt = nowMs;
    alerts.push({
      kind: 'joins-collapse', severity: 'error', email: true, stampKey: 'lastCollapseAlertAt',
      title: 'Email list: joins/week collapsed',
      description: `Total list joins this week: ${joinsPerWeek} (${channels}), below the ` +
        `${ALERT_JOINS_PER_WEEK}/wk floor; baseline ~${BASELINE_JOINS_PER_WEEK}/wk since accounts launched. ` +
        `Most joins come from account sign-in, so first check that sign-in works on the live site and that ` +
        `sign_in_completed still reaches PostHog, then the inline forms and the gate modal. ` +
        `Gate history: ${GATE_DOC} (the cold-start gate is permanent, do not revert it for this).`,
    });
  }

  // Sustained multi-week decline. Only judged weeks count; a week that could
  // not be judged resets the history so low/low/gap/low is not "3 in a row".
  if (judged) {
    next.recentJoins = [...(next.recentJoins || []), joinsPerWeek].slice(-SUSTAINED_DECLINE_WEEKS);
    if (
      next.recentJoins.length === SUSTAINED_DECLINE_WEEKS
      && next.recentJoins.every((v) => v >= ALERT_JOINS_PER_WEEK && v < SUSTAINED_DECLINE_THRESHOLD)
    ) {
      const declineCooled = !next.lastDeclineAlertAt || nowMs - next.lastDeclineAlertAt >= COLLAPSE_COOLDOWN_MS;
      if (declineCooled) {
        next.lastDeclineAlertAt = nowMs;
        alerts.push({
          kind: 'sustained-decline', severity: 'error', email: true, stampKey: 'lastDeclineAlertAt',
          title: 'Email list: sustained multi-week decline in joins',
          description: `Total joins/wk for the last ${SUSTAINED_DECLINE_WEEKS} weeks: ${next.recentJoins.join(', ')}. ` +
            `Each stayed above the ${ALERT_JOINS_PER_WEEK}/wk collapse floor but all are below half the ` +
            `~${BASELINE_JOINS_PER_WEEK}/wk baseline. This week: ${channels}.`,
        });
      }
    }
  } else {
    next.recentJoins = [];
  }

  alerts.push({
    kind: 'modal-captures', severity: 'warning', email: false, logOnly: true,
    title: 'Email gate modal: captures/week (log only)',
    description: `modal captures/wk ${modalPerWeek} (${summary.convRatePct ?? '–'}% conv/impression). ` +
      `Signed-in users never see the modal, so this runs ~2-5/wk with zero weeks on noise; not alerted.`,
  });

  alerts.push({
    kind: 'weekly-summary', severity: 'warning', email: false, logOnly: true,
    title: 'Email list joins — weekly summary',
    description: `total joins/wk ${joinsPerWeek ?? '–'} vs baseline ~${BASELINE_JOINS_PER_WEEK}/wk (${channels}) · ` +
      `gate impressions ${impressions} · dismissed ${summary.dismissRatePct ?? '–'}% · ` +
      `mobile bounce ${summary.mobileBouncePct ?? '–'}%.`,
  });

  return { alerts, state: next };
}

module.exports = {
  decideEmailGateFunnelAlerts,
  BASELINE_JOINS_PER_WEEK,
  ALERT_JOINS_PER_WEEK,
  MIN_IMPRESSIONS_FOR_ALERT,
  SUSTAINED_DECLINE_WEEKS,
  SUSTAINED_DECLINE_THRESHOLD,
};
