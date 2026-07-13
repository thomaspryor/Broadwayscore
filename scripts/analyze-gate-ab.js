#!/usr/bin/env node
/**
 * analyze-gate-ab.js — readout for the 'mobile-gate-timing' email-capture A/B.
 *
 * analyze-ab-test.js CANNOT read this test (it is hardwired to ticket_click /
 * Impact conversions), so this script owns the gate experiment:
 *
 *   PRIMARY   captures-per-mobile-visitor (ITT): denominator = distinct persons
 *             with a touch-device $pageview in-window (NOT persons shown the
 *             modal — the dismissal cooldown suppresses impressions
 *             differentially, per-visitor is robust to that).
 *   SECONDARY captures-per-impression, per-arm.
 *   GUARDRAIL dismissal rate per arm; single-pageview (bounce) rate by person.
 *
 * Conventions: events carry ab_variant='flag:mobile-gate-timing,timing:<t>'
 * (see src/lib/gate-logic.ts). timing:fallback rows (flags never loaded — ad
 * blockers/opt-outs) are EXCLUDED from arm comparisons, mirroring
 * analyze-ab-test.js's fallback exclusion. Real-users lens: owner + SG/CN/VN
 * excluded (memory: feedback_analytics_real_users_lens).
 *
 * Pre-registered decision rules (2026-07-12 plan review):
 *   - Run >= 8 weeks OR >= 950 gate_modal_shown per arm before judging the primary.
 *   - Weekly peeks look at GUARDRAILS ONLY (dismissal, bounce).
 *   - Never change flag rollout without user approval (A/B guardrails memory).
 *
 * Usage: node scripts/analyze-gate-ab.js [--days=30]
 * Env: POSTHOG_PERSONAL_API_KEY
 */

const PROJECT_ID = '332742';
const FLAG_PREFIX = 'flag:mobile-gate-timing,timing:';
const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '--days=30').split('=')[1], 10);
const JSON_OUT = process.argv.includes('--json'); // machine-readable summary for monitor-gate-ab.js

const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) { console.error('POSTHOG_PERSONAL_API_KEY not set'); process.exit(1); }

// Shared real-users predicate (owner + bot-heavy geos excluded)
const REAL_USERS = `
  (JSONExtractString(properties,'$geoip_country_code') NOT IN ('SG','CN','VN')
   OR JSONExtractString(properties,'$geoip_country_code') = '')
  AND coalesce(JSONExtractString(person.properties,'is_owner'),'') != 'true'`;

async function hogql(query) {
  const res = await fetch(`https://us.posthog.com/api/projects/${PROJECT_ID}/query/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results || [];
}

function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(2)}%` : 'n/a'; }

async function main() {
  const summary = { days: DAYS, tagged: false, arms: {}, mobileVisitors: 0, mobileBouncePct: null };
  const say = (...a) => { if (!JSON_OUT) console.log(...a); };
  say(`Mobile gate timing A/B — last ${DAYS} days (real users)\n${'='.repeat(56)}`);

  // Per-arm funnel: shown / dismissed / captured, events + distinct persons
  const funnel = await hogql(`
    SELECT
      replaceOne(JSONExtractString(properties,'ab_variant'), '${FLAG_PREFIX}', '') AS arm,
      event,
      count() AS events,
      count(DISTINCT person_id) AS people
    FROM events
    WHERE event IN ('gate_modal_shown','gate_modal_dismissed','email_captured')
      AND JSONExtractString(properties,'ab_variant') LIKE '${FLAG_PREFIX}%'
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}
    GROUP BY arm, event ORDER BY arm, event`);

  if (funnel.length === 0) {
    say('\nNo ab_variant-tagged gate events yet.');
    say('Expected before the PostHog flag is created, or within the first hours after.');
    say('Baseline (untagged) events still flow — this script only reads tagged ones.');
  } else {
    summary.tagged = true;
  }

  const arms = {};
  for (const [arm, event, events, people] of funnel) {
    arms[arm] = arms[arm] || {};
    arms[arm][event] = { events, people };
  }

  // ITT denominator: distinct persons with a touch-device pageview in-window.
  // $pageview fires before flags resolve, so we can't split the DENOMINATOR by
  // arm from event properties; with a 50/50 sticky flag the arms' denominators
  // are equal in expectation — report total/2 per arm and say so.
  const [[mobileVisitors]] = await hogql(`
    SELECT count(DISTINCT person_id)
    FROM events
    WHERE event = '$pageview'
      AND JSONExtractString(properties,'$device_type') IN ('Mobile','Tablet')
      AND timestamp > now() - INTERVAL ${DAYS} DAY
      AND ${REAL_USERS}`);
  const perArmVisitors = mobileVisitors / 2;
  summary.mobileVisitors = mobileVisitors;
  say(`\nMobile/tablet visitors (ITT denominator): ${mobileVisitors} total → ~${Math.round(perArmVisitors)}/arm (50/50 sticky assumption)`);

  for (const [arm, ev] of Object.entries(arms)) {
    const shown = ev.gate_modal_shown || { events: 0, people: 0 };
    const dismissed = ev.gate_modal_dismissed || { events: 0, people: 0 };
    const captured = ev.email_captured || { events: 0, people: 0 };
    const excluded = arm === 'fallback';
    summary.arms[arm] = { shown: shown.people, dismissed: dismissed.people, captured: captured.people };
    say(`\n— ${arm}${excluded ? '  [EXCLUDED from comparison: flags never resolved]' : ''}`);
    say(`  shown: ${shown.people} people (${shown.events} events) | dismissed: ${dismissed.people} (${pct(dismissed.people, shown.people)}) | captured: ${captured.people}`);
    if (!excluded) {
      say(`  PRIMARY captures/mobile-visitor: ${pct(captured.people, perArmVisitors)}`);
      say(`  captures/impression: ${pct(captured.people, shown.people)}`);
    }
  }

  // Guardrail: bounce (single-pageview persons) among mobile visitors.
  // Sliced by PERSON not event property — the initial $pageview fires before
  // flags load, so event-level flag props are unreliable for the first hit.
  const [[bouncers]] = await hogql(`
    SELECT countIf(pages = 1) FROM (
      SELECT person_id, count() AS pages
      FROM events
      WHERE event = '$pageview'
        AND JSONExtractString(properties,'$device_type') IN ('Mobile','Tablet')
        AND timestamp > now() - INTERVAL ${DAYS} DAY
        AND ${REAL_USERS}
      GROUP BY person_id)`);
  summary.mobileBouncePct = mobileVisitors > 0 ? +((bouncers / mobileVisitors) * 100).toFixed(2) : null;
  say(`\nGUARDRAIL mobile bounce (site-wide, both arms): ${bouncers}/${mobileVisitors} single-page visitors (${pct(bouncers, mobileVisitors)})`);
  say('  Compare week-over-week after flag launch; per-arm bounce needs $feature/ person-level join — escalate if site-wide moves >3pts.');

  const shownTotal = Object.entries(arms).filter(([a]) => a !== 'fallback')
    .reduce((s2, [, ev]) => s2 + (ev.gate_modal_shown?.people || 0), 0);
  summary.nonFallbackShown = shownTotal;
  say(`\nSample progress: ${shownTotal} non-fallback impressions (pre-registered floor: 950/arm ≈ 1,900 total).`);
  say('Reminder: weekly peeks = guardrails only. Do not judge the primary early, do not touch flag rollout without user approval.');
  if (JSON_OUT) console.log(JSON.stringify(summary));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
