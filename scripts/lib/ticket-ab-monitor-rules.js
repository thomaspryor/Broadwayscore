/**
 * ticket-ab-monitor-rules.js — pure decision rules for the weekly
 * ticket-single-button A/B monitor (scripts/monitor-ticket-ab.js, card #392).
 *
 * Input: the --json summary from analyze-ab-test.js (14d, default flag
 * ticket-single-button — see scripts/lib/significance.js for the primary
 * p-value math) + persisted state. Output: alerts to send + new state. No
 * I/O here (CLAUDE.md §15 test-extraction pattern).
 *
 * Why this exists: the analyzer's previous inline zTest() printed
 * "p-value: NaN" on every run for a week (clicks passed into
 * conversion-count slots — see significance.js header for the post-mortem)
 * and nothing was watching the output; a manual audit on 2026-07-24 caught
 * it. The revenue-bearing gate-cold-start and email-gate-funnel A/Bs both
 * already had weekly monitors — this test did not.
 *
 * Two actionable alert kinds + a log-only weekly summary, per the
 * guardrails memory (memory/feedback_ab_test_guardrails.md): this monitor
 * NEVER judges a winner and NEVER touches the PostHog flag — it only flags
 * DATA problems and nudges the owner once the primary is both significant
 * and adequately powered.
 *   primary-data-problem  (email) primary p suppressed or degenerate — the
 *                          data pipeline has a problem, not a result to
 *                          read (join-coverage gap, cross-variant leakage,
 *                          flag drift, degenerate proportions, or an
 *                          unexpected variant count). 6d cooldown so a
 *                          persistent problem re-alerts weekly rather than
 *                          firing once and going silent. Suppressed itself
 *                          when combined clicks are below MIN_CLICKS_FOR_DATA_PROBLEM
 *                          — a near-empty window naturally degenerates
 *                          (e.g. one variant with zero clicks trips
 *                          computeAbSignificance's "need exactly 2 variants"
 *                          check) and is ramp-up, not breakage; the other
 *                          two weekly monitors in this repo apply the same
 *                          traffic-floor carve-out (MIN_SHOWN_FOR_ALERT in
 *                          gate-cold-start-rules.js, MIN_IMPRESSIONS_FOR_ALERT
 *                          in email-gate-funnel-rules.js).
 *   significance-reached  (email, once) primary p < 0.05 AND not flagged
 *                          underpowered — time to read the result. Fires
 *                          once ever; the p can move with more data and
 *                          that's expected, not a fresh alert (the owner
 *                          decides when to act, this monitor only nudges).
 *                          Carries primary.note verbatim when present (e.g.
 *                          significance.js's asymmetric-zero-conversions
 *                          caution) so a clean-looking p never hides a
 *                          pipeline warning the prose analyzer would have
 *                          shown.
 *   weekly-summary          LOG-ONLY.
 */

const COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
// Below this combined-clicks floor, a degenerate primary (most commonly
// computeAbSignificance's "need exactly 2 variants" when one arm saw zero
// clicks this window) reads as ramp-up, not a pipeline break — don't email.
// suppressed reasons (flag drift, join-coverage gap, cross-variant leakage)
// are never traffic-dependent and always alert regardless of volume.
const MIN_CLICKS_FOR_DATA_PROBLEM = 20;

/**
 * @param {object} summary  --json output of analyze-ab-test.js
 * @param {object} state    persisted monitor state (may be {})
 * @param {number} nowMs    Date.now()
 * @returns {{ alerts: Array<{kind:string,severity:string,email:boolean,title:string,description:string}>, state: object }}
 */
function decideTicketAbAlerts(summary = {}, state = {}, nowMs = 0) {
  const next = { ...state };
  const alerts = [];
  const primary = summary.primary || {};
  const variants = summary.variants || [];

  const flagStatusText = summary.flagHealthy === false
    ? ` Flag health: ${summary.flagHealthProblem || 'unhealthy'}.`
    : '';

  // --- Primary data problem (suppressed or degenerate p) ---
  const totalClicks = variants.reduce((s, v) => s + (v.clicks || 0), 0);
  // Only degenerate (structural: wrong variant count, zero trials, no
  // variance) gets the ramp-up carve-out — suppressed reasons are real
  // problems (flag drift, join gap, leakage) independent of traffic volume.
  const isRampUp = !!primary.degenerate && !primary.suppressed && totalClicks < MIN_CLICKS_FOR_DATA_PROBLEM;
  const dataProblemReason = isRampUp ? null : (primary.suppressed || primary.degenerate || null);
  const cooledProblem = !next.lastDataProblemAlertAt || nowMs - next.lastDataProblemAlertAt >= COOLDOWN_MS;
  if (dataProblemReason && cooledProblem) {
    next.lastDataProblemAlertAt = nowMs;
    alerts.push({
      kind: 'primary-data-problem', severity: 'error', email: true, stampKey: 'lastDataProblemAlertAt',
      title: 'ticket-single-button A/B: primary metric unreadable',
      description: `The primary p is not computable this window: ${dataProblemReason}.${flagStatusText} ` +
        `Fix the underlying data issue before trusting node scripts/analyze-ab-test.js output — this is ` +
        `exactly the class of failure (silent NaN p-value, card #392) the monitor exists to catch.`,
    });
  }

  // --- Significance-reached nudge (once ever) ---
  if (!dataProblemReason && primary.significant === true && !primary.underpowered && !next.significanceAlertedAt) {
    next.significanceAlertedAt = nowMs;
    const pStr = typeof primary.p === 'number' ? primary.p.toFixed(4) : 'n/a';
    const noteText = primary.note ? ` ⚠ Analyzer caution: ${primary.note}` : '';
    alerts.push({
      kind: 'significance-reached', severity: 'error', email: true, stampKey: 'significanceAlertedAt',
      title: 'ticket-single-button A/B has reached significance at adequate power',
      description: `p = ${pStr} (< 0.05), and the sample clears the underpowered advisory floors.${noteText} ` +
        `Run node scripts/analyze-ab-test.js and decide with the user — this monitor never judges the ` +
        `winner or touches the flag (memory/feedback_ab_test_guardrails.md rule 1).`,
    });
  }

  // --- Weekly summary (log-only) ---
  const variantsText = variants.length
    ? variants.map(v => `${v.name} (${v.clicks} clicks, ${v.convUsers} conv users)`).join(', ')
    : 'n/a';
  const pText = isRampUp
    ? 'n/a (ramp-up)'
    : dataProblemReason
      ? `n/a (data problem)`
      : (typeof primary.p === 'number' ? primary.p.toFixed(4) : 'n/a');
  alerts.push({
    kind: 'weekly-summary', severity: 'warning', email: false, logOnly: true,
    title: 'ticket-single-button A/B — weekly summary',
    description: `flag ${summary.flagHealthy === false ? 'UNHEALTHY' : summary.flagHealthy === true ? 'healthy' : 'unchecked'} · ` +
      `variants: ${variantsText} · primary p ${pText}${primary.underpowered ? ' [underpowered]' : ''}.`,
  });

  return { alerts, state: next };
}

module.exports = { decideTicketAbAlerts, COOLDOWN_MS, MIN_CLICKS_FOR_DATA_PROBLEM };
