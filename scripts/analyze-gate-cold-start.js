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
 * What it reports, per arm:
 *   EXPOSED   distinct persons with $feature_flag_called for this flag
 *             (true per-arm ITT denominator — better than the /2 assumption
 *             in analyze-gate-ab.js, which predates exposure tracking here)
 *   SHOWN / DISMISSED / CAPTURED  modal events carrying ab_cold_start
 *   PRIMARY   modal captures per exposed person (ITT)
 *   GUARDRAILS absolute captures/week, impressions split, dismissal rate
 *
 * Plus a FLAG HEALTH check via the PostHog management API — alerts if the
 * flag was deleted, deactivated, or its 50/50 split was edited (protection
 * against a session or UI edit silently breaking the experiment).
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

// Shared real-users predicate (owner + bot-heavy geos excluded) — mirrors analyze-gate-ab.js
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
  const res = await fetch(`https://us.posthog.com/api/projects/${PROJECT_ID}/feature_flags/?search=${FLAG_KEY}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  if (!res.ok) return { ok: false, problem: `flag API ${res.status}` };
  const flags = ((await res.json()).results || []).filter(f => f.key === FLAG_KEY);
  if (flags.length === 0) return { ok: false, problem: 'FLAG DOES NOT EXIST — experiment is not running (this exact failure killed mobile-gate-timing)' };
  const f = flags[0];
  if (!f.active) return { ok: false, problem: 'flag exists but is INACTIVE — all traffic falling back' };
  const variants = f.filters?.multivariate?.variants || [];
  const split = variants.map(v => `${v.key}:${v.rollout_percentage}`).sort().join(',');
  if (split !== 'cold-start:50,control:50') {
    return { ok: false, problem: `variant split drifted from pre-registered 50/50: [${split}]` };
  }
  const rollout = f.filters?.groups?.[0]?.rollout_percentage;
  if (rollout !== 100 && rollout != null) return { ok: false, problem: `release rollout is ${rollout}% (expected 100%)` };
  return { ok: true, problem: null };
}

async function main() {
  const summary = { days: DAYS, flagHealthy: false, arms: {} };
  const say = (...a) => { if (!JSON_OUT) console.log(...a); };
  say(`gate-cold-start A/B — since ${EXPERIMENT_START}, window ${DAYS}d (real users)\n${'='.repeat(60)}`);

  const health = await flagHealth();
  summary.flagHealthy = health.ok;
  say(`FLAG HEALTH: ${health.ok ? '✅ active, 50/50, 100% rollout' : `🛑 ${health.problem}`}`);
  if (!health.ok) say('  → fix the flag BEFORE reading any numbers below; data during the broken window is contaminated.');

  // Per-arm exposure (ITT denominators) from PostHog's own flag-called events.
  const exposure = await hogql(`
    SELECT JSONExtractString(properties,'$feature_flag_response') AS arm,
      count(DISTINCT person_id) AS people
    FROM events
    WHERE event = '$feature_flag_called'
      AND JSONExtractString(properties,'$feature_flag') = '${FLAG_KEY}'
      AND ${WINDOW} AND ${REAL_USERS}
    GROUP BY arm`);
  const exposed = Object.fromEntries(exposure.map(([arm, n]) => [arm, n]));

  // Per-arm modal funnel. trigger != '' excludes inline header/footer captures
  // that share the email_captured event name.
  const funnel = await hogql(`
    SELECT JSONExtractString(properties,'ab_cold_start') AS arm, event,
      count(DISTINCT person_id) AS people
    FROM events
    WHERE event IN ('gate_modal_shown','gate_modal_dismissed','email_captured')
      AND JSONExtractString(properties,'ab_cold_start') != ''
      AND (event != 'email_captured' OR JSONExtractString(properties,'trigger') != '')
      AND ${WINDOW} AND ${REAL_USERS}
    GROUP BY arm, event`);

  const arms = {};
  for (const [arm, event, people] of funnel) {
    arms[arm] = arms[arm] || {};
    arms[arm][event] = people;
  }
  const weeks = Math.max(DAYS / 7, 1 / 7);

  for (const arm of ['control', 'cold-start', 'fallback']) {
    const ev = arms[arm] || {};
    const exp = exposed[arm] || 0;
    const shown = ev.gate_modal_shown || 0;
    const dismissed = ev.gate_modal_dismissed || 0;
    const captured = ev.email_captured || 0;
    const excluded = arm === 'fallback';
    summary.arms[arm] = { exposed: exp, shown, dismissed, captured };
    say(`\n— ${arm}${excluded ? '  [EXCLUDED from comparison: flag never resolved]' : ''}`);
    say(`  exposed: ${exp} | shown: ${shown} | dismissed: ${dismissed} (${pct(dismissed, shown)}) | captured: ${captured}`);
    if (!excluded) {
      say(`  PRIMARY captures/exposed (ITT): ${pct(captured, exp)}`);
      say(`  captures/impression: ${pct(captured, shown)} | captures/week: ${(captured / weeks).toFixed(2)}`);
    }
  }

  // Pre-registered guardrails + decision reminders
  const totalCapturesPerWeek = ((arms['control']?.email_captured || 0) + (arms['cold-start']?.email_captured || 0)) / weeks;
  summary.totalCapturesPerWeek = +totalCapturesPerWeek.toFixed(2);
  say(`\nGUARDRAIL combined modal captures/week: ${totalCapturesPerWeek.toFixed(2)} (baseline ~4/wk pre-experiment; alert < 1/wk for 2 consecutive weeks → revert per pre-registration)`);
  const cShown = arms['control']?.gate_modal_shown || 0;
  const tShown = arms['cold-start']?.gate_modal_shown || 0;
  say(`GUARDRAIL impression split control:treatment = ${cShown}:${tShown} (expect roughly 10:1 — parity would mean the treatment gate is NOT applying)`);
  say(`\nRules: minimum 4 weeks before judging the primary (from ${EXPERIMENT_START}); full pre-registration in docs/experiments/gate-cold-start.md.`);
  if (JSON_OUT) console.log(JSON.stringify(summary));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
