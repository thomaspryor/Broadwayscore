#!/usr/bin/env node
/**
 * analyze-gate-cold-start.js — CANONICAL readout for the 'gate-cold-start'
 * email-gate A/B (control = no page minimum vs cold-start = 2-page minimum).
 *
 * Pre-registration + decision rules: docs/experiments/gate-cold-start.md.
 * This script is the only approved way to read the experiment — ad-hoc HogQL
 * has burned us twice: (1) email_captured is fired by BOTH the gate modal and
 * inline header/footer forms (modal-attributed = trigger != ''), and
 * (2) fallback-labeled rows (flag never resolved) must be EXCLUDED, never
 * merged into control (2026-07-20 analysis, card 3a3637c5-416f-816c).
 *
 * ATTRIBUTION MODEL — person-level ITT (2026-07-21 adversarial review fix):
 * a person's arm = the FIRST $feature_flag_called response in-window, and ALL
 * of that person's modal events count for that arm — including any events the
 * client stamped 'fallback' because they fired in the seconds before the flag
 * resolved. Event-label attribution (the first draft) dropped those events
 * from the numerator while keeping the person in the denominator — classic
 * ITT contamination. Under person-attribution the pre-resolution race can
 * only attenuate the measured effect toward null, never bias an arm.
 * Persons with gate events but NO exposure event (flags endpoint ad-blocked)
 * are reported as 'unexposed' and excluded from comparison.
 *
 * Per arm:
 *   EXPOSED   distinct persons whose first $feature_flag_called response = arm
 *   SHOWN / DISMISSED / CAPTURED  those persons' modal events (captured =
 *             trigger != '' only, excluding inline header/footer forms)
 *   PRIMARY   modal captures per exposed person (ITT)
 *   GUARDRAILS absolute captures/week, impressions split, dismissal rate
 *
 * Plus a FLAG HEALTH check via the PostHog management API — alerts if the
 * flag was deleted, deactivated, or its 50/50 split was edited.
 *
 * Usage: node scripts/analyze-gate-cold-start.js [--days=28] [--json]
 * Env: POSTHOG_PERSONAL_API_KEY
 */

const PROJECT_ID = '332742';
const FLAG_KEY = 'gate-cold-start';
const EXPERIMENT_START = '2026-07-21'; // pre-registered — do not backdate
const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '--days=28').split('=')[1], 10);
const JSON_OUT = process.argv.includes('--json');

const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) { console.error('POSTHOG_PERSONAL_API_KEY not set'); process.exit(1); }

// Shared real-users predicate (owner + bot-heavy geos excluded) — same lens as analyze-email-gate-funnel.js
const REAL_USERS = `
  (JSONExtractString(properties,'$geoip_country_code') NOT IN ('SG','CN','VN')
   OR JSONExtractString(properties,'$geoip_country_code') = '')
  AND coalesce(JSONExtractString(person.properties,'is_owner'),'') != 'true'`;

// Window: never earlier than the experiment start, even if --days reaches back further.
const WINDOW = `timestamp > greatest(now() - INTERVAL ${DAYS} DAY, toDateTime('${EXPERIMENT_START} 00:00:00'))`;

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

async function flagHealth() {
  // Decision logic lives in the registry (evaluateFlagHealth — the general
  // form of what used to be an inline reimplementation here); this fn only
  // fetches and maps the live PostHog shape. Expected state (incl.
  // ensure_experience_continuity=false — pre-registered correct for this
  // anonymous-only experiment) comes from REGISTERED_FLAGS.
  const { REGISTERED_FLAGS, evaluateFlagHealth } = require('./lib/flag-registry');
  const entry = REGISTERED_FLAGS.find(e => e.key === FLAG_KEY);
  if (!entry) return { ok: false, problem: `no REGISTERED_FLAGS entry for ${FLAG_KEY} — add one (flag-registry.js)` };
  const res = await fetch(`https://us.posthog.com/api/projects/${PROJECT_ID}/feature_flags/?search=${FLAG_KEY}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  if (!res.ok) return { ok: false, problem: `flag API ${res.status}` };
  const f = ((await res.json()).results || []).find(r => r.key === FLAG_KEY);
  const live = f ? {
    active: f.active,
    variants: (f.filters?.multivariate?.variants || []).map(v => ({ key: v.key, pct: v.rollout_percentage })),
    rollout: f.filters?.groups?.[0]?.rollout_percentage,
    ensure_experience_continuity: !!f.ensure_experience_continuity,
  } : null;
  return evaluateFlagHealth(live, entry.expected);
}

async function main() {
  const summary = { days: DAYS, flagHealthy: false, arms: {} };
  const say = (...a) => { if (!JSON_OUT) console.log(...a); };
  say(`gate-cold-start A/B — since ${EXPERIMENT_START}, window ${DAYS}d (real users, person-level ITT)\n${'='.repeat(64)}`);

  const health = await flagHealth();
  summary.flagHealthy = health.ok;
  summary.flagHealthProblem = health.problem;
  say(`FLAG HEALTH: ${health.ok ? '✅ active, 50/50, 100% rollout' : `🛑 ${health.problem}`}`);
  if (!health.ok) say('  → fix the flag BEFORE reading any numbers below; data during the broken window is contaminated.');

  // Person → arm from the FIRST RESOLVED flag response in-window (sticky
  // assignment means later responses should agree; first-wins makes the
  // mapping stable). Excludes unresolved (null) responses from the argMin
  // candidates — PostHog's getFeatureFlag() fires $feature_flag_called on
  // every call, including the ones ProGateContext's poll loop makes before
  // the flags network response lands, so an unfiltered argMin can pick a
  // premature null over the real value a moment later.
  //
  // ROOT CAUSE (2026-08-26, diagnosed via scripts/diagnose-gate-cold-start-
  // join.js after this script reported 0.00% captures/exposed in BOTH arms
  // since launch): NOT the null-argMin issue above (real, worth keeping, but
  // it barely moved the count). The actual cause is that PostHog's HogQL
  // query API silently caps GROUP BY result sets at ~100 rows when no LIMIT
  // is given — every GROUP BY query in this file was returning ~100 rows
  // regardless of the true cardinality (confirmed: the exact same query with
  // an explicit `LIMIT 100000` returned 21,234 rows — control:10,648 /
  // cold-start:10,586 real exposed people, not 51/49). Every hogql() call
  // below that returns MULTIPLE rows (GROUP BY) needs an explicit LIMIT well
  // above any realistic result size; count(DISTINCT ...) scalar aggregates
  // (a single row) were never affected.
  const exposure = await hogql(`
    SELECT person_id,
      argMin(JSONExtractString(properties,'$feature_flag_response'), timestamp) AS arm
    FROM events
    WHERE event = '$feature_flag_called'
      AND JSONExtractString(properties,'$feature_flag') = '${FLAG_KEY}'
      AND JSONExtractString(properties,'$feature_flag_response') IN ('control', 'cold-start')
      AND ${WINDOW} AND ${REAL_USERS}
    GROUP BY person_id
    LIMIT 1000000`);
  const personArm = new Map(exposure.map(([pid, arm]) => [pid, arm]));

  // ALL modal events per person in-window (label-agnostic — see header).
  // captured = trigger != '' excludes inline header/footer captures that
  // share the email_captured event name.
  const perPerson = await hogql(`
    SELECT person_id, event, count() AS n
    FROM events
    WHERE ((event IN ('gate_modal_shown','gate_modal_dismissed') AND JSONExtractString(properties,'ab_cold_start') != '')
        OR (event = 'email_captured' AND JSONExtractString(properties,'trigger') != ''))
      AND ${WINDOW} AND ${REAL_USERS}
    GROUP BY person_id, event
    LIMIT 1000000`);

  const arms = { control: {}, 'cold-start': {}, unexposed: {} };
  const seen = { control: new Set(), 'cold-start': new Set(), unexposed: new Set() };
  for (const [pid, event, n] of perPerson) {
    const rawArm = personArm.get(pid);
    const arm = rawArm === 'control' || rawArm === 'cold-start' ? rawArm : 'unexposed';
    const bucket = arms[arm];
    // People counts, not event counts — one person converting twice is one person.
    bucket[event] = bucket[event] || new Set();
    bucket[event].add(pid);
    seen[arm].add(pid);
  }

  // Elapsed-time-aware weeks: never divide by more time than the experiment
  // has existed (2026-07-21 review: DAYS/7 on day 1 understated rates ~28x).
  const msSinceStart = Date.now() - new Date(`${EXPERIMENT_START}T00:00:00Z`).getTime();
  const effectiveDays = Math.max(Math.min(DAYS, msSinceStart / 86400000), 1 / 24);
  const weeks = effectiveDays / 7;
  say(`Window in effect: ${effectiveDays.toFixed(1)} days of experiment runtime`);
  // For monitor-gate-cold-start.js's 4-week milestone check — meaningful only
  // when --days is large enough that effectiveDays isn't itself clipped by DAYS
  // (i.e. the cumulative window, not the 7d recent one).
  summary.effectiveDays = +effectiveDays.toFixed(2);
  summary.experimentStart = EXPERIMENT_START;

  const exposedCount = { control: 0, 'cold-start': 0 };
  for (const [, arm] of exposure) {
    if (arm === 'control' || arm === 'cold-start') exposedCount[arm]++;
  }

  for (const arm of ['control', 'cold-start', 'unexposed']) {
    const ev = arms[arm];
    const exp = arm === 'unexposed' ? seen.unexposed.size : exposedCount[arm];
    const shown = ev.gate_modal_shown?.size || 0;
    const dismissed = ev.gate_modal_dismissed?.size || 0;
    const captured = ev.email_captured?.size || 0;
    const excluded = arm === 'unexposed';
    summary.arms[arm] = { exposed: exp, shown, dismissed, captured };
    say(`\n— ${arm}${excluded ? '  [EXCLUDED from comparison: no flag exposure event — flags endpoint blocked]' : ''}`);
    say(`  exposed: ${exp} | shown: ${shown} | dismissed: ${dismissed} (${pct(dismissed, shown)}) | captured: ${captured}`);
    if (!excluded) {
      say(`  PRIMARY captures/exposed (ITT): ${pct(captured, exp)}`);
      say(`  captures/impression: ${pct(captured, shown)} | captures/week: ${(captured / weeks).toFixed(2)}`);
    }
  }

  const totalCapturesPerWeek = ((arms['control'].email_captured?.size || 0) + (arms['cold-start'].email_captured?.size || 0)) / weeks;
  summary.totalCapturesPerWeek = +totalCapturesPerWeek.toFixed(2);
  say(`\nGUARDRAIL combined modal captures/week: ${totalCapturesPerWeek.toFixed(2)} (baseline ~4/wk pre-experiment; alert < 1/wk for 2 consecutive weeks → revert per pre-registration)`);
  const cShown = arms['control'].gate_modal_shown?.size || 0;
  const tShown = arms['cold-start'].gate_modal_shown?.size || 0;
  say(`GUARDRAIL impression split control:treatment = ${cShown}:${tShown} (expect roughly 10:1 — parity would mean the treatment gate is NOT applying)`);
  say(`\nRules: minimum 4 weeks before judging the primary (from ${EXPERIMENT_START}); full pre-registration in docs/experiments/gate-cold-start.md.`);
  if (JSON_OUT) console.log(JSON.stringify(summary));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
