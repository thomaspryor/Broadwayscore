/**
 * flag-parity-rules.js — pure decision rules for the weekly flag-parity
 * monitor (scripts/monitor-flag-parity.js, card #250).
 *
 * Input: the live PostHog flag state for every scripts/lib/flag-registry.js
 * entry (fetched by the runner from the feature_flags API) plus a fresh
 * static scan of src/ for referenced-but-unregistered keys. No I/O here
 * (CLAUDE.md §15 test-extraction pattern) — see flag-parity-rules.test.mjs.
 *
 * Alert kinds (every emailed alert carries stampKey — the runner reverts it
 * on delivery failure so the alert retries next week instead of being lost):
 *   flag-unhealthy      (email) a registered flag's live state doesn't match
 *                        its expected state (missing/inactive/split drift/
 *                        unexpectedly-created). Per-flag cooldown.
 *   code-unregistered   (email) src/ references a flag key with no registry
 *                        entry — this is the mobile-gate-timing failure mode
 *                        itself; the CI unit test should already catch this
 *                        before merge, so seeing it here means CI was
 *                        bypassed or the registry drifted after merge.
 *   weekly-summary       LOG-ONLY
 */

const COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * @param {object} input
 * @param {Array<{key:string, ok:boolean, problem:string|null}>} input.flagHealth  one entry per REGISTERED_FLAGS key
 * @param {Array<{key:string, files:string[]}>} input.unregistered  keys referenced in src/ with no registry entry
 * @param {object} state    persisted monitor state (may be {})
 * @param {number} nowMs    Date.now()
 * @returns {{ alerts: Array<{kind:string,severity:string,email:boolean,title:string,description:string,stampKey?:string}>, state: object }}
 */
function decideFlagParityAlerts(input = {}, state = {}, nowMs = 0) {
  const flagHealth = input.flagHealth || [];
  const unregistered = input.unregistered || [];
  const next = { ...state };
  const alerts = [];

  for (const entry of flagHealth) {
    const stampKey = `lastUnhealthyAlertAt:${entry.key}`;
    if (entry.ok) {
      // Recovered — clear any cooldown stamp so a future recurrence alerts fresh.
      if (next[stampKey]) delete next[stampKey];
      continue;
    }
    const cooled = !next[stampKey] || nowMs - next[stampKey] >= COOLDOWN_MS;
    if (!cooled) continue;
    next[stampKey] = nowMs;
    alerts.push({
      kind: 'flag-unhealthy',
      severity: 'error',
      email: true,
      stampKey,
      title: `Flag parity: '${entry.key}' does not match its registered state`,
      description: `${entry.problem} Registry: scripts/lib/flag-registry.js. Fix the PostHog flag to match, or update the registry entry if the expected state has legitimately changed.`,
    });
  }

  if (unregistered.length > 0) {
    const cooled = !next.lastUnregisteredAlertAt || nowMs - next.lastUnregisteredAlertAt >= COOLDOWN_MS;
    if (cooled) {
      next.lastUnregisteredAlertAt = nowMs;
      const list = unregistered.map((u) => `${u.key} (${u.files.join(', ')})`).join('; ');
      alerts.push({
        kind: 'code-unregistered',
        severity: 'error',
        email: true,
        stampKey: 'lastUnregisteredAlertAt',
        title: `Flag parity: src/ references ${unregistered.length} flag key(s) with no registry entry`,
        description: `${list}. This is the exact failure mode that shipped the mobile-gate-timing incident (code polling a flag PostHog never created). The scripts/lib/flag-registry.test.mjs CI gate should have caught this before merge — if you're seeing this email, either CI was bypassed or the registry drifted after merge. Add an entry to scripts/lib/flag-registry.js.`,
      });
    }
  } else if (next.lastUnregisteredAlertAt) {
    delete next.lastUnregisteredAlertAt;
  }

  const unhealthyCount = flagHealth.filter((f) => !f.ok).length;
  alerts.push({
    kind: 'weekly-summary',
    severity: 'warning',
    email: false,
    logOnly: true,
    title: 'Flag parity — weekly summary',
    description: `${flagHealth.length} registered flag(s), ${unhealthyCount} unhealthy · ${unregistered.length} unregistered flag key(s) referenced in src/.`,
  });

  return { alerts, state: next };
}

module.exports = { decideFlagParityAlerts, COOLDOWN_MS };
