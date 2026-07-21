/**
 * gate-cold-start-rules.js — pure decision rules for the weekly gate-cold-start
 * A/B monitor (scripts/monitor-gate-cold-start.js, card #247).
 *
 * Input: two --json summaries from analyze-gate-cold-start.js — RECENT (7d,
 * for guardrails: flag health, absolute captures/week, impression-split
 * sanity) and CUMULATIVE (a large --days so the analyzer's own
 * greatest(now()-DAYS, EXPERIMENT_START) window clip makes it "since start" —
 * used for the 4-week primary-readout milestone and per-arm ITT numbers). No
 * I/O here (CLAUDE.md §15 test-extraction pattern).
 *
 * Pre-registered rules — all sourced from analyze-gate-cold-start.js's own
 * header/inline comments (docs/experiments/gate-cold-start.md does not exist
 * yet; that script is the only canonical source of the rules today):
 *   - Flag health: exists, active, 50/50 split, 100% rollout. Anything else
 *     means the experiment isn't actually running as designed and any
 *     numbers read during the broken window are contaminated.
 *   - PRIMARY guardrail: combined modal captures/week < 1 for 2 CONSECUTIVE
 *     meaningful weeks (baseline ~4/wk pre-experiment) → grounds to consider
 *     reverting the cold-start gate.
 *   - Guardrail: impression split control:cold-start should be roughly 10:1
 *     (the 2-page minimum suppresses treatment impressions by selection) —
 *     drift toward parity means the treatment filter silently stopped
 *     applying, not that the experiment is "working".
 *   - Primary judgment: minimum 4 weeks (28 days) of experiment runtime
 *     before reading the ITT primary metric — this fires once as a "time to
 *     look" nudge; it never judges the primary itself.
 *
 * Alert kinds (every emailed alert carries stampKey — the runner reverts it
 * on delivery failure so the alert retries next week instead of being lost):
 *   flag-unhealthy           (email) flag missing/inactive/split drifted (6d cooldown)
 *   capture-collapse         (email) combined captures/wk < 1 for 2 consecutive meaningful weeks (6d cooldown)
 *   funnel-stalled           (email) traffic that reached the meaningful floor before has now dropped under it (6d cooldown)
 *   impression-split-broken  (email) control:cold-start shown ratio collapsed toward parity (6d cooldown)
 *   primary-ready            (email) 4 weeks of runtime reached — time to read the ITT primary (once)
 *   weekly-summary           LOG-ONLY
 */

const BASELINE_CAPTURES_PER_WEEK = 4;
const ALERT_CAPTURES_PER_WEEK = 1;
const CAPTURE_COLLAPSE_STREAK_WEEKS = 2;
const MIN_SHOWN_FOR_ALERT = 10; // combined control+cold-start gate impressions this window
const IMPRESSION_SPLIT_EXPECTED_RATIO = 10; // control:cold-start, per pre-registration
const IMPRESSION_SPLIT_MIN_RATIO = 5; // roughly half the expected 10:1 — below this with meaningful traffic = filter probably broken
const IMPRESSION_SPLIT_MIN_SHOWN = 30; // combined shown before judging the split
const PRIMARY_MIN_DAYS = 28; // 4 weeks
const COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;

function armShown(summary, arm) { return summary?.arms?.[arm]?.shown || 0; }
function armCaptured(summary, arm) { return summary?.arms?.[arm]?.captured || 0; }
function armExposed(summary, arm) { return summary?.arms?.[arm]?.exposed || 0; }
function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(2)}%` : 'n/a'; }

/**
 * @param {object} windows  { recent, cumulative } — two analyze-gate-cold-start.js --json summaries
 * @param {object} state    persisted monitor state (may be {})
 * @param {number} nowMs    Date.now()
 * @returns {{ alerts: Array<{kind:string,severity:string,email:boolean,title:string,description:string}>, state: object }}
 */
function decideGateColdStartAlerts(windows = {}, state = {}, nowMs = 0) {
  const recent = windows.recent || {};
  const cumulative = windows.cumulative || {};
  const next = { ...state };
  const alerts = [];

  // --- Flag health ---
  const cooledFlag = !next.lastFlagUnhealthyAlertAt || nowMs - next.lastFlagUnhealthyAlertAt >= COOLDOWN_MS;
  if (recent.flagHealthy === false && cooledFlag) {
    next.lastFlagUnhealthyAlertAt = nowMs;
    alerts.push({
      kind: 'flag-unhealthy', severity: 'error', email: true, stampKey: 'lastFlagUnhealthyAlertAt',
      title: 'gate-cold-start A/B: flag is unhealthy',
      description: `The PostHog flag is not in its pre-registered state${recent.flagHealthProblem ? ` — ${recent.flagHealthProblem}` : ''}. ` +
        `Fix the flag before trusting any numbers from node scripts/analyze-gate-cold-start.js.`,
    });
  }

  // --- Combined captures/week guardrail (2 consecutive meaningful weeks) ---
  const controlShown = armShown(recent, 'control');
  const coldStartShown = armShown(recent, 'cold-start');
  const combinedShown = controlShown + coldStartShown;
  const hasTraffic = combinedShown >= MIN_SHOWN_FOR_ALERT;
  const capturesPerWeek = typeof recent.totalCapturesPerWeek === 'number' ? recent.totalCapturesPerWeek : null;

  const everReachedFloor = !!next.everReachedTrafficFloor;
  if (hasTraffic) next.everReachedTrafficFloor = true;

  if (hasTraffic && capturesPerWeek !== null) {
    next.consecutiveBelowCaptureFloor = capturesPerWeek < ALERT_CAPTURES_PER_WEEK
      ? (next.consecutiveBelowCaptureFloor || 0) + 1
      : 0;
    const cooledCapture = !next.lastCaptureCollapseAlertAt || nowMs - next.lastCaptureCollapseAlertAt >= COOLDOWN_MS;
    if (next.consecutiveBelowCaptureFloor >= CAPTURE_COLLAPSE_STREAK_WEEKS && cooledCapture) {
      next.lastCaptureCollapseAlertAt = nowMs;
      alerts.push({
        kind: 'capture-collapse', severity: 'error', email: true, stampKey: 'lastCaptureCollapseAlertAt',
        title: 'gate-cold-start A/B: combined captures/week collapsed',
        description: `Combined modal captures/week (${capturesPerWeek}) has been below the ${ALERT_CAPTURES_PER_WEEK}/wk floor ` +
          `for ${next.consecutiveBelowCaptureFloor} consecutive meaningful weeks (baseline ~${BASELINE_CAPTURES_PER_WEEK}/wk pre-experiment). ` +
          `Per pre-registration, 2+ consecutive weeks below floor is grounds to consider reverting the cold-start gate.`,
      });
    }
  } else {
    // No meaningful reading this window (ramp-up, a data blip, or a missing
    // field) — "consecutive" means back-to-back MEANINGFUL weeks, so a gap
    // week must break any streak in progress rather than leaving it dangling
    // (otherwise below-floor / gap / below-floor reads as "2 consecutive").
    next.consecutiveBelowCaptureFloor = 0;
    if (!hasTraffic && everReachedFloor) {
      const cooledStalled = !next.lastStalledAlertAt || nowMs - next.lastStalledAlertAt >= COOLDOWN_MS;
      if (cooledStalled) {
        next.lastStalledAlertAt = nowMs;
        alerts.push({
          kind: 'funnel-stalled', severity: 'error', email: true, stampKey: 'lastStalledAlertAt',
          title: 'gate-cold-start A/B: gate impressions collapsed',
          description: `Only ${combinedShown} combined gate impressions this window, down from a previously-healthy level ` +
            `(below the ${MIN_SHOWN_FOR_ALERT}-impression floor). Check whether the modal still renders and whether ` +
            `gate_modal_shown/email_captured are still firing (node scripts/analyze-gate-cold-start.js).`,
        });
      }
    }
  }

  // --- Impression-split guardrail ---
  if (combinedShown >= IMPRESSION_SPLIT_MIN_SHOWN) {
    const bigger = Math.max(controlShown, coldStartShown);
    const smaller = Math.max(Math.min(controlShown, coldStartShown), 1); // avoid /0
    const ratio = bigger / smaller;
    const cooledSplit = !next.lastSplitAlertAt || nowMs - next.lastSplitAlertAt >= COOLDOWN_MS;
    if (ratio < IMPRESSION_SPLIT_MIN_RATIO && cooledSplit) {
      next.lastSplitAlertAt = nowMs;
      alerts.push({
        kind: 'impression-split-broken', severity: 'error', email: true, stampKey: 'lastSplitAlertAt',
        title: 'gate-cold-start A/B: impression split drifted toward parity',
        description: `control:cold-start shown = ${controlShown}:${coldStartShown} (ratio ${ratio.toFixed(1)}:1, expected roughly ` +
          `${IMPRESSION_SPLIT_EXPECTED_RATIO}:1). Parity suggests the cold-start 2-page-minimum filter has stopped applying — ` +
          `check the client-side gate logic, not just the flag.`,
      });
    }
  }

  // --- Primary-readiness milestone (once) ---
  const elapsedDays = typeof cumulative.effectiveDays === 'number' ? cumulative.effectiveDays : null;
  if (!next.primaryReadyAlertedAt && elapsedDays !== null && elapsedDays >= PRIMARY_MIN_DAYS) {
    next.primaryReadyAlertedAt = nowMs;
    const itt = (arm) => pct(armCaptured(cumulative, arm), armExposed(cumulative, arm));
    alerts.push({
      kind: 'primary-ready', severity: 'error', email: true, stampKey: 'primaryReadyAlertedAt',
      title: 'gate-cold-start A/B has reached the 4-week minimum — time to judge',
      description: `${elapsedDays.toFixed(1)} days since ${cumulative.experimentStart || 'launch'}. ITT captures/exposed: ` +
        `control ${itt('control')} (exposed ${armExposed(cumulative, 'control')}), ` +
        `cold-start ${itt('cold-start')} (exposed ${armExposed(cumulative, 'cold-start')}). ` +
        `Run node scripts/analyze-gate-cold-start.js and decide with the user — this monitor never judges the primary itself.`,
    });
  }

  // --- Weekly summary (log-only) ---
  alerts.push({
    kind: 'weekly-summary', severity: 'warning', email: false, logOnly: true,
    title: 'gate-cold-start A/B — weekly guardrail summary',
    description: `flag ${recent.flagHealthy ? 'healthy' : 'UNHEALTHY'} · control shown ${controlShown} / cold-start shown ${coldStartShown} ` +
      `(${coldStartShown > 0 ? (controlShown / coldStartShown).toFixed(1) : 'n/a'}:1) · combined captures/wk ${capturesPerWeek ?? '–'} ` +
      `(baseline ~${BASELINE_CAPTURES_PER_WEEK}/wk) · elapsed ${elapsedDays !== null ? elapsedDays.toFixed(1) : '–'}d of ${PRIMARY_MIN_DAYS}d minimum.`,
  });

  return { alerts, state: next };
}

module.exports = {
  decideGateColdStartAlerts,
  BASELINE_CAPTURES_PER_WEEK,
  ALERT_CAPTURES_PER_WEEK,
  CAPTURE_COLLAPSE_STREAK_WEEKS,
  MIN_SHOWN_FOR_ALERT,
  IMPRESSION_SPLIT_EXPECTED_RATIO,
  IMPRESSION_SPLIT_MIN_RATIO,
  IMPRESSION_SPLIT_MIN_SHOWN,
  PRIMARY_MIN_DAYS,
};
