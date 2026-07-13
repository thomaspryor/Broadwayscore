/**
 * gate-ab-monitor-rules.js — pure decision rules for the weekly
 * mobile-gate-timing A/B monitor (scripts/monitor-gate-ab.js).
 *
 * Input: the --json summary from analyze-gate-ab.js + persisted state.
 * Output: alerts to send + the new state. No I/O here (CLAUDE.md §15).
 *
 * Pre-registered decision rules (2026-07-12 plan review):
 *   - Power floor: 950 gate_modal_shown people per REAL arm (control AND
 *     end-of-content). fallback is excluded everywhere.
 *   - Duration ceiling: 8 weeks from the first real-arm impression.
 *   - Weekly peeks are guardrails only; the monitor NEVER judges the primary
 *     metric and NEVER touches flag rollout (A/B guardrails memory).
 *
 * Alert kinds:
 *   experiment-live   (email) first real-arm impressions seen — test started
 *   power-reached     (email) both arms >= POWER_FLOOR — time to judge
 *   duration-reached  (email) 8 weeks elapsed — judge or extend
 *   bounce-breach     (email) site mobile bounce > baseline + 3pts (7d cooldown)
 *   dismissal-skew    (email) arms' dismissal rates differ > 15pts w/ >=200 shown each (7d cooldown)
 *   weekly-summary    (discord only) whenever the experiment is live
 */

const POWER_FLOOR = 950;
const DURATION_MS = 56 * 24 * 60 * 60 * 1000; // 8 weeks
const BOUNCE_BREACH_PTS = 3;
const SKEW_PTS = 15;
const SKEW_MIN_SHOWN = 200;
const BREACH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const REAL_ARMS = ['control', 'end-of-content'];

function armShown(summary, arm) {
  return summary?.arms?.[arm]?.shown || 0;
}
function dismissRate(summary, arm) {
  const a = summary?.arms?.[arm];
  if (!a || !a.shown) return null;
  return (a.dismissed / a.shown) * 100;
}

/**
 * @param {object} summary  analyze-gate-ab.js --json output
 * @param {object} state    persisted monitor state (may be {})
 * @param {number} nowMs    Date.now()
 * @returns {{ alerts: Array<{kind:string,severity:string,email:boolean,title:string,description:string}>, state: object }}
 */
function decideGateAlerts(summary, state = {}, nowMs = 0) {
  const next = { ...state };
  const alerts = [];

  const realShown = REAL_ARMS.map((a) => armShown(summary, a));
  const experimentLive = realShown.some((n) => n > 0);

  // Pre-flag (or fallback-only traffic): stay silent, but keep a bounce
  // baseline rolling so the post-launch comparison uses fresh pre-launch data.
  if (!experimentLive) {
    if (typeof summary?.mobileBouncePct === 'number') next.baselineBouncePct = summary.mobileBouncePct;
    return { alerts, state: next };
  }

  // First real-arm impressions → experiment officially started.
  if (!next.startedAt) {
    next.startedAt = nowMs;
    if (typeof next.baselineBouncePct !== 'number' && typeof summary?.mobileBouncePct === 'number') {
      next.baselineBouncePct = summary.mobileBouncePct;
    }
    alerts.push({
      kind: 'experiment-live', severity: 'error', email: true,
      title: 'Mobile gate A/B is LIVE',
      description: `First real-arm impressions detected (control: ${realShown[0]}, end-of-content: ${realShown[1]}). ` +
        `Weekly guardrail monitoring is on. Power floor: ${POWER_FLOOR}/arm; duration ceiling: 8 weeks. ` +
        `Baseline mobile bounce: ${next.baselineBouncePct ?? 'n/a'}%.`,
    });
  }

  // Power floor reached on BOTH arms → time to judge (once).
  if (!next.powerAlertedAt && realShown.every((n) => n >= POWER_FLOOR)) {
    next.powerAlertedAt = nowMs;
    alerts.push({
      kind: 'power-reached', severity: 'error', email: true,
      title: 'Mobile gate A/B has reached statistical power — time to judge',
      description: `Both arms passed the pre-registered floor of ${POWER_FLOOR} impressions ` +
        `(control: ${realShown[0]}, end-of-content: ${realShown[1]}). ` +
        `Run \`node scripts/analyze-gate-ab.js\` and decide with the user. ` +
        `Do NOT change flag rollout without explicit user approval.`,
    });
  }

  // Duration ceiling (once) — even if power unmet, the 8-week checkpoint is a decision point.
  if (!next.durationAlertedAt && next.startedAt && nowMs - next.startedAt >= DURATION_MS) {
    next.durationAlertedAt = nowMs;
    alerts.push({
      kind: 'duration-reached', severity: 'error', email: true,
      title: 'Mobile gate A/B hit the 8-week checkpoint',
      description: `8 weeks since first impressions. Arms: control ${realShown[0]}, end-of-content ${realShown[1]} ` +
        `(floor ${POWER_FLOOR}/arm${realShown.every((n) => n >= POWER_FLOOR) ? ' — met' : ' — NOT met; judge with caution or extend'}). ` +
        `Decide with the user; never end the test unilaterally.`,
    });
  }

  // Guardrail: site-wide mobile bounce vs pre-launch baseline (+3pts), 7d cooldown.
  if (typeof next.baselineBouncePct === 'number' && typeof summary?.mobileBouncePct === 'number') {
    const delta = summary.mobileBouncePct - next.baselineBouncePct;
    const cooled = !next.lastBounceAlertAt || nowMs - next.lastBounceAlertAt >= BREACH_COOLDOWN_MS;
    if (delta > BOUNCE_BREACH_PTS && cooled) {
      next.lastBounceAlertAt = nowMs;
      alerts.push({
        kind: 'bounce-breach', severity: 'error', email: true,
        title: 'Mobile gate A/B guardrail: bounce rate up',
        description: `Site-wide mobile bounce ${summary.mobileBouncePct}% vs ${next.baselineBouncePct}% pre-launch baseline ` +
          `(+${delta.toFixed(1)}pts > ${BOUNCE_BREACH_PTS}pt guardrail). Investigate before letting the test run on.`,
      });
    }
  }

  // Guardrail: dismissal-rate skew between arms (both arms sufficiently sampled), 7d cooldown.
  const dr = REAL_ARMS.map((a) => dismissRate(summary, a));
  if (dr.every((d) => d !== null) && REAL_ARMS.every((a) => armShown(summary, a) >= SKEW_MIN_SHOWN)) {
    const skew = Math.abs(dr[0] - dr[1]);
    const cooled = !next.lastSkewAlertAt || nowMs - next.lastSkewAlertAt >= BREACH_COOLDOWN_MS;
    if (skew > SKEW_PTS && cooled) {
      next.lastSkewAlertAt = nowMs;
      alerts.push({
        kind: 'dismissal-skew', severity: 'error', email: true,
        title: 'Mobile gate A/B guardrail: dismissal rates diverging',
        description: `control ${dr[0].toFixed(1)}% vs end-of-content ${dr[1].toFixed(1)}% dismissal ` +
          `(${skew.toFixed(1)}pt gap > ${SKEW_PTS}pt guardrail). One arm may be annoying users — review with the user.`,
      });
    }
  }

  // Weekly Discord-only summary whenever live (severity below the email policy line).
  alerts.push({
    kind: 'weekly-summary', severity: 'warning', email: false,
    title: 'Mobile gate A/B — weekly guardrail summary',
    description: `control: ${armShown(summary, 'control')} shown / ${dismissRate(summary, 'control')?.toFixed(1) ?? '–'}% dismissed · ` +
      `end-of-content: ${armShown(summary, 'end-of-content')} shown / ${dismissRate(summary, 'end-of-content')?.toFixed(1) ?? '–'}% dismissed · ` +
      `fallback (excluded): ${armShown(summary, 'fallback')} · mobile bounce ${summary.mobileBouncePct ?? '–'}% (baseline ${next.baselineBouncePct ?? '–'}%) · ` +
      `power floor ${POWER_FLOOR}/arm.`,
  });

  return { alerts, state: next };
}

module.exports = { decideGateAlerts, POWER_FLOOR, DURATION_MS, BOUNCE_BREACH_PTS, SKEW_PTS, SKEW_MIN_SHOWN };
