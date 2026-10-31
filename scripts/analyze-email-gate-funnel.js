#!/usr/bin/env node
/**
 * analyze-email-gate-funnel.js — readout for the OVERALL email-gate funnel (card #240).
 *
 * Unlike the retired analyze-gate-ab.js (the mobile-gate-timing A/B — never launched, statistically
 * dead under the cold-start gate), this tracks the funnel end-to-end regardless of any
 * experiment: modal-only captures, impressions, dismissal, plus TOTAL list joins/week
 * (modal + inline + account sign-in, BRO-6371), which is what the weekly monitor alerts on.
 *
 * Account sign-in joins the list via src/lib/auto-subscribe.ts (Formspree, source
 * auth-auto) and never fires email_captured, so sign-ins are counted from
 * sign_in_completed. totalJoins is DISTINCT people across all three channels.
 * These sign-ins are a proxy: formspreeAuthJoins separately confirms accepted
 * auth-auto submissions, since sign-in events fire even when subscription fails.
 *
 * Modal-only filter (MANDATORY): email_captured fires from BOTH the gate modal (carries
 * a `trigger` property) AND inline header/footer forms (no `trigger` property).
 * Unfiltered counts overstate gate captures — same bug fixed in
 * posthog-friction-analyzer's getGateFunnel (scripts/lib/posthog-query.js).
 *
 * ABSOLUTE captures/week is the PRIMARY guardrail, not conversion rate — the cold-start
 * gate (2+ pages/session, live 2026-07-20 16:37 UTC) was PROJECTED at launch to cut
 * impressions ~85-90% and lift conversion rate ~5-8x by pure selection; real measurement
 * (only available after an unrelated HogQL row-cap bug fix, 2026-08-26) instead shows a
 * steady ~2.5-2.8:1 cut — see docs/experiments/gate-cold-start.md "Amendments" 2026-09-07
 * (BRO-2952). The launch-time projection number below is kept for historical context only;
 * do not treat it as a live guardrail. Rate thresholds alone would declare victory while
 * list growth actually falls. Baseline: ~0.93 modal captures/day (P0, Jun 15 - Jul 12).
 * Gate history and decisions: docs/experiments/gate-cold-start.md
 *
 * Real-users lens: owner + SG/CN/VN excluded (memory: feedback_analytics_real_users_lens).
 *
 * Usage: node scripts/analyze-email-gate-funnel.js [--days=7] [--json]
 * Env: POSTHOG_PERSONAL_API_KEY, FORMSPREE_SUBSCRIBER_FORM_ID,
 * FORMSPREE_TOKEN (or FORMSPREE_SUBSCRIBER_API_KEY)
 */

const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '--days=7').split('=')[1], 10);
const JSON_OUT = process.argv.includes('--json');

const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) { console.error('POSTHOG_PERSONAL_API_KEY not set'); process.exit(1); }

// Shared Real Users predicate (owner + bot-heavy geos excluded) — the one
// definition lives in scripts/lib/posthog-query.js so a new bot geo is added once.
const { REAL_USERS_WHERE: REAL_USERS, phQuery } = require('./lib/posthog-query');
const { getGatePageViewSummary } = require('./lib/gate-modal-guardrail');
const { getFormspreeAuthJoins } = require('./lib/formspree-auth-joins');

// Modal-attributed only — see file header.
const MODAL_ONLY = `JSONExtractString(properties,'trigger') != ''`;

const hogql = phQuery; // shared helper retries PostHog 429/502/503 (BRO-5998)

function pct(n, d) { return d > 0 ? +((n / d) * 100).toFixed(2) : null; }

// Merges the shown/dismissed rows (grouped by copyVersion+event) and the
// captured rows (grouped by copyVersion) into one per-version funnel, so a
// version's dismiss/conversion rate can be read directly off the summary
// instead of cross-referencing two tables by hand.
function buildByCopyVersion(shownDismissedRows, capturedRows) {
  const versions = {};
  const bucket = (v) => (versions[v] ||= { shown: { n: 0, people: 0 }, dismissed: { n: 0, people: 0 }, captured: { n: 0, people: 0 } });
  for (const [copyVersion, event, n, people] of shownDismissedRows) {
    const key = copyVersion || '(none)';
    const slot = event === 'gate_modal_shown' ? 'shown' : 'dismissed';
    bucket(key)[slot] = { n: Number(n), people: Number(people) };
  }
  for (const [copyVersion, n, people] of capturedRows) {
    const key = copyVersion || '(none)';
    bucket(key).captured = { n: Number(n), people: Number(people) };
  }
  for (const v of Object.values(versions)) {
    v.dismissRatePct = pct(v.dismissed.people, v.shown.people);
    v.convRatePct = pct(v.captured.people, v.shown.people);
  }
  return versions;
}

async function main() {
  const say = (...a) => { if (!JSON_OUT) console.log(...a); };
  say(`Email gate funnel (overall) — last ${DAYS} days, real users\n${'='.repeat(60)}`);

  const funnel = await hogql(`
    SELECT event, count() AS n, count(DISTINCT person_id) AS people
    FROM events
    WHERE event IN ('gate_modal_shown', 'gate_modal_dismissed')
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}
    GROUP BY event`);

  const map = {};
  for (const [event, n, people] of funnel) map[event] = { n: Number(n), people: Number(people) };
  const shown = map.gate_modal_shown || { n: 0, people: 0 };
  const dismissed = map.gate_modal_dismissed || { n: 0, people: 0 };

  const capturedRows = await hogql(`
    SELECT count() AS n, count(DISTINCT person_id) AS people
    FROM events
    WHERE event = 'email_captured'
      AND ${MODAL_ONLY}
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}`);
  const [capturedN, capturedPeople] = capturedRows[0] || [0, 0];

  // List joins by channel (BRO-6371). One query so totalJoins dedupes a person
  // who, say, signed in and also used the inline form in the same window.
  const joinsRows = await hogql(`
    SELECT
      count(DISTINCT if(event = 'email_captured' AND JSONExtractString(properties,'trigger') = '', person_id, NULL)) AS inline,
      count(DISTINCT if(event = 'sign_in_completed', person_id, NULL)) AS signIns,
      count(DISTINCT if(event = 'sign_in_completed' AND JSONExtractString(properties,'is_new_user') = 'true', person_id, NULL)) AS signInsNew,
      count(DISTINCT person_id) AS total
    FROM events
    WHERE event IN ('email_captured', 'sign_in_completed')
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}`);
  const [inlinePeople, signInPeople, signInNewPeople, totalJoinPeople] = (joinsRows[0] || [0, 0, 0, 0]).map(Number);

  const byTriggerRows = await hogql(`
    SELECT JSONExtractString(properties,'trigger') AS trigger, count() AS n, count(DISTINCT person_id) AS people
    FROM events
    WHERE event = 'gate_modal_shown'
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}
    GROUP BY trigger ORDER BY n DESC`);

  // copyVersion dimension (task #1206) — isolates the #586 copy rewrite's
  // effect on conversion/dismiss from general week-to-week trend. Events
  // emitted before this landed carry no copyVersion property and group under ''.
  const byCopyVersionShownDismissedRows = await hogql(`
    SELECT JSONExtractString(properties,'copyVersion') AS copyVersion, event, count() AS n, count(DISTINCT person_id) AS people
    FROM events
    WHERE event IN ('gate_modal_shown', 'gate_modal_dismissed')
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}
    GROUP BY copyVersion, event`);

  const byCopyVersionCapturedRows = await hogql(`
    SELECT JSONExtractString(properties,'copyVersion') AS copyVersion, count() AS n, count(DISTINCT person_id) AS people
    FROM events
    WHERE event = 'email_captured'
      AND ${MODAL_ONLY}
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}
    GROUP BY copyVersion`);

  const mobileVisitorsRows = await hogql(`
    SELECT count(DISTINCT person_id)
    FROM events
    WHERE event = '$pageview'
      AND JSONExtractString(properties,'$device_type') IN ('Mobile','Tablet')
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}`);
  const mobileVisitors = Number(mobileVisitorsRows[0]?.[0] || 0);

  const bouncersRows = await hogql(`
    SELECT countIf(pages = 1) FROM (
      SELECT person_id, count() AS pages
      FROM events
      WHERE event = '$pageview'
        AND JSONExtractString(properties,'$device_type') IN ('Mobile','Tablet')
        AND timestamp > now() - INTERVAL ${DAYS} DAY
        AND ${REAL_USERS}
      GROUP BY person_id
      LIMIT 1000000)`);
  const bouncers = Number(bouncersRows[0]?.[0] || 0);
  const pageViewGuardrail = await getGatePageViewSummary(DAYS);
  const formspreeAuth = await getFormspreeAuthJoins({ days: DAYS });

  const summary = {
    days: DAYS,
    impressions: shown.people,
    impressionEvents: shown.n,
    dismissed: dismissed.people,
    dismissRatePct: pct(dismissed.people, shown.people),
    captured: Number(capturedPeople),
    capturedEvents: Number(capturedN),
    convRatePct: pct(Number(capturedPeople), shown.people),
    capturesPerWeek: +((Number(capturedPeople) / DAYS) * 7).toFixed(2),
    inlineCaptures: inlinePeople,
    signIns: signInPeople,
    signInsNew: signInNewPeople,
    ...formspreeAuth,
    totalJoins: totalJoinPeople,
    totalJoinsPerWeek: +((totalJoinPeople / DAYS) * 7).toFixed(2),
    mobileBouncePct: mobileVisitors > 0 ? +((bouncers / mobileVisitors) * 100).toFixed(2) : null,
    byTrigger: Object.fromEntries(byTriggerRows.map(([t, n, people]) => [t || '(none)', { n: Number(n), people: Number(people) }])),
    byCopyVersion: buildByCopyVersion(byCopyVersionShownDismissedRows, byCopyVersionCapturedRows),
    pageViewGuardrail,
  };

  say(`Impressions (shown): ${summary.impressions} people (${summary.impressionEvents} events)`);
  say(`Dismissed: ${summary.dismissed} (${summary.dismissRatePct}%)`);
  say(`Modal captures: ${summary.captured} people / ${summary.capturedEvents} events (${summary.convRatePct}% conv/impression)`);
  say(`Captures/week (extrapolated from ${DAYS}d): ${summary.capturesPerWeek} — baseline ~0.93/day (~6.5/wk pre-cold-start-gate)`);
  say(`Inline captures: ${summary.inlineCaptures} people · account sign-ins: ${summary.signIns} people (${summary.signInsNew} new accounts)`);
  say(`Formspree auth-auto submissions: ${summary.formspreeAuthJoins ?? 'unknown'} (${summary.formspreeAuthJoinsStatus})`);
  say(`Total list joins: ${summary.totalJoins} people (${summary.totalJoinsPerWeek}/wk) — baseline ~35/wk since accounts launched 2026-10-02`);
  say(`Mobile bounce: ${bouncers}/${mobileVisitors} (${summary.mobileBouncePct}%)`);
  say(`By trigger: ${JSON.stringify(summary.byTrigger)}`);
  say(`By copy version: ${JSON.stringify(summary.byCopyVersion)}`);
  say(`Passive page-view minimum: ${JSON.stringify(summary.pageViewGuardrail)}`);

  if (JSON_OUT) console.log(JSON.stringify(summary));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
