/**
 * claude-auth-health — pure decision logic for check-claude-auth-health.js
 * (task #1076).
 *
 * Incident 2026-08-05: the Mac's Claude OAuth token was revoked server-side.
 * Every headless launch died (cmux auto-dispatch, opening-night monitor) and
 * nothing reported it until a dispatch was attempted by accident, five shows
 * before opening. `claude auth status` reported {loggedIn: true} the whole
 * time — it only reads the on-disk token's presence, not its server-side
 * validity, so it is structurally incapable of catching this class.
 *
 * The only way to detect a revoked token is a REAL minimal API call.
 * scripts/lib/claude-cli.js's preflightAuth() already does exactly that
 * (authPing spawns `claude -p ... --output-format json` and checks for an
 * actual "pong" in the result) — it is the same probe cmux-launch.js uses to
 * decide whether to refuse a launch, so this health check reports the truth
 * about what cmux-launch would actually do, not a separate guess.
 *
 * Extracted per CLAUDE.md rule 15 (test extraction pattern): the decision of
 * whether a preflightAuth() result counts as healthy must never re-derive
 * itself from `claude auth status` — that status field is carried through
 * ONLY for the alert body/logging, never for the pass/fail call, so a test
 * can prove the exact real-world bug shape (auth status lies, probe doesn't)
 * without spawning a real `claude` process.
 */
'use strict';

/**
 * @param {object} args
 * @param {{ok: boolean, mode: 'oauth'|'api-key'|'fail', detail?: string, storedDetail?: string}} args.preflight
 *   Return value of preflightAuth() from scripts/lib/claude-cli.js.
 * @param {{loggedIn?: boolean, authMethod?: string}|null} [args.authStatus]
 *   Best-effort `claude auth status` result, carried through for reporting
 *   only — NEVER consulted for the ok/fail verdict (see file header).
 * @returns {{ok: boolean, mode: string, reason: string, authStatusLoggedIn: boolean|null}}
 */
function evaluateAuthHealth({ preflight, authStatus = null }) {
  if (!preflight || typeof preflight.ok !== 'boolean') {
    throw new Error('evaluateAuthHealth requires a preflightAuth() result');
  }
  const authStatusLoggedIn = authStatus && typeof authStatus.loggedIn === 'boolean'
    ? authStatus.loggedIn
    : null;

  if (preflight.ok) {
    const reason = preflight.mode === 'api-key'
      ? `real call succeeded via ANTHROPIC_API_KEY fallback (pay-per-token) — stored OAuth login failed: ${preflight.storedDetail || 'unknown'}`
      : 'real call succeeded via stored OAuth login';
    return { ok: true, mode: preflight.mode, reason, authStatusLoggedIn };
  }

  return {
    ok: false,
    mode: 'fail',
    reason: `real call failed — ${preflight.detail || 'no working credential'}`,
    authStatusLoggedIn,
  };
}

const REPAIR_STEPS = 'claude auth logout && claude auth login && claude -p "say ok"';

/**
 * Builds the routeAlert() payload for a failed (or degraded) health result.
 * Pure — never calls routeAlert itself, so it's testable without a network.
 */
function buildAlertPayload(health) {
  const statusNote = health.authStatusLoggedIn === true
    ? " `claude auth status` still reports loggedIn:true — that command only checks the on-disk token's presence, not its server-side validity. Do not trust it."
    : '';
  return {
    conditionKey: 'claude-auth:revoked',
    title: 'Claude OAuth token revoked or unusable on the Mac',
    description: `check-claude-auth-health.js's real API call failed: ${health.reason}.${statusNote} Every headless launch (cmux auto-dispatch, the opening-night monitor) will die until this is fixed. Repair: \`${REPAIR_STEPS}\``,
    severity: 'error',
    disposition: 'human',
    hint: REPAIR_STEPS,
  };
}

module.exports = { evaluateAuthHealth, buildAlertPayload, REPAIR_STEPS };
