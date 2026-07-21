#!/usr/bin/env node
/**
 * monitor-flag-parity.js — weekly flag-parity guardrail (card #250).
 *
 * Generalizes the flagHealth() check in analyze-gate-cold-start.js to every
 * flag in scripts/lib/flag-registry.js, and adds a second independent check:
 * a fresh static scan of src/ for flag keys with no registry entry at all
 * (the CI unit test — scripts/lib/flag-registry.test.mjs — should already
 * catch this pre-merge; this is the post-merge backstop in case CI was
 * bypassed or the registry drifted after merge).
 *
 * Root incident this exists to catch (2026-07-12, discovered 07-20): the
 * mobile-gate-timing A/B shipped client code + monitor + guardrail emails
 * with a PostHog flag that was never created. Nothing compared code-side to
 * server-side. This script is that comparison, run on a schedule.
 *
 * State: data/audit/flag-parity-monitor-state.json (committed by workflow).
 * Usage: node scripts/monitor-flag-parity.js [--dry-run]
 * Env: POSTHOG_PERSONAL_API_KEY, RESEND_API_KEY + OWNER_EMAIL (email alerts).
 */

const fs = require('fs');
const path = require('path');
const { runWeeklyMonitor } = require('./lib/weekly-monitor-runner');
const { decideFlagParityAlerts } = require('./lib/flag-parity-rules');
const { REGISTERED_FLAGS, extractReferencedFlagKeys, checkFlagParity, evaluateFlagHealth } = require('./lib/flag-registry');

const PROJECT_ID = '332742';
const DRY_RUN = process.argv.includes('--dry-run');
// Test seam: FLAG_PARITY_FIXTURE (a JSON file standing in for the live
// PostHog /feature_flags/ response) and FLAG_PARITY_STATE_FILE.
const FIXTURE_PATH = process.env.FLAG_PARITY_FIXTURE || null;
const STATE_PATH = process.env.FLAG_PARITY_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'flag-parity-monitor-state.json');

// One `?search=` lookup per registered flag (bounded by REGISTERED_FLAGS.length,
// not by how many flags exist in the PostHog project) — mirrors the proven
// per-flag flagHealth() pattern in analyze-gate-cold-start.js rather than
// paging a `?limit=N` listing, which would silently stop seeing flags past N
// if the project ever grows past that page size.
async function fetchLiveFlag(apiKey, key) {
  const res = await fetch(`https://us.posthog.com/api/projects/${PROJECT_ID}/feature_flags/?search=${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`PostHog feature_flags API ${res.status} for '${key}': ${(await res.text()).slice(0, 200)}`);
  const results = (await res.json()).results || [];
  const f = results.find((r) => r.key === key);
  if (!f) return null;
  return {
    active: f.active,
    variants: (f.filters?.multivariate?.variants || []).map((v) => ({ key: v.key, pct: v.rollout_percentage })),
    rollout: f.filters?.groups?.[0]?.rollout_percentage,
  };
}

async function fetchLiveFlags() {
  if (FIXTURE_PATH) {
    return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  }
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!apiKey) throw new Error('POSTHOG_PERSONAL_API_KEY not set');
  const byKey = new Map();
  for (const entry of REGISTERED_FLAGS) {
    byKey.set(entry.key, await fetchLiveFlag(apiKey, entry.key));
  }
  return byKey;
}

async function loadData() {
  const liveFlags = await fetchLiveFlags();
  const getLive = (key) => (liveFlags instanceof Map ? liveFlags.get(key) : liveFlags[key]) || null;

  const flagHealth = REGISTERED_FLAGS.map((entry) => {
    const live = getLive(entry.key);
    const { ok, problem } = evaluateFlagHealth(live, entry.expected);
    return { key: entry.key, ok, problem };
  });

  const { keys: referenced, unresolved } = extractReferencedFlagKeys();
  const { missing: unregistered } = checkFlagParity(referenced, REGISTERED_FLAGS);
  if (unresolved.length > 0) {
    console.log(`WARNING: ${unresolved.length} getFeatureFlag() call(s) with an arg the static scanner couldn't resolve: ${JSON.stringify(unresolved)} — these are invisible to this monitor and the CI gate.`);
  }

  return { flagHealth, unregistered };
}

function logData({ flagHealth, unregistered }) {
  console.log(`Flag health: ${JSON.stringify(flagHealth)}`);
  console.log(`Unregistered: ${JSON.stringify(unregistered.map((u) => u.key))}`);
}

// Deliberately never fails the job on alert conditions — the email alert IS
// the signal, same as monitor-gate-cold-start.js / monitor-gate-ab.js. A
// nonzero exit here would turn the workflow red every week an alert is
// cooling down (not just the week it fires), risking a "Workflow
// repeat-failure" digest promotion on top of the already-targeted email.
runWeeklyMonitor({ loadData, decideFn: decideFlagParityAlerts, statePath: STATE_PATH, dryRun: DRY_RUN, logData })
  .catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
