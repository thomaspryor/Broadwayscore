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
 * @param {{ok: boolean, mode: 'oauth'|'api-key'|'fail', detail?: string, storedDetail?: string, reason?: string}} args.preflight
 *   Return value of preflightAuth() from scripts/lib/claude-cli.js. `reason`
 *   (BRO-2971) is 'spawn-starved' when the probe never reached the auth
 *   handshake (OS/jetsam kill, ETIMEDOUT, ENOMEM) vs 'auth-rejected' when the
 *   CLI actually ran and said no — only present when ok is false.
 * @param {{loggedIn?: boolean, authMethod?: string}|null} [args.authStatus]
 *   Best-effort `claude auth status` result, carried through for reporting
 *   only — NEVER consulted for the ok/fail verdict (see file header).
 * @returns {{ok: boolean, mode: string, reason: string, authStatusLoggedIn: boolean|null}}
 *   `mode` is 'spawn-starved' on a starved failure — buildAlertPayload's ONLY
 *   input for which alert to build (never re-derived from `reason` text).
 */
function evaluateAuthHealth({ preflight, authStatus = null }) {
  if (!preflight || typeof preflight.ok !== 'boolean') {
    throw new Error('evaluateAuthHealth requires a preflightAuth() result');
  }
  const authStatusLoggedIn = authStatus && typeof authStatus.loggedIn === 'boolean'
    ? authStatus.loggedIn
    : null;

  if (preflight.ok) {
    // BRO-2971 (adversarial-review finding): preflight.storedReason carries
    // the STORED-LOGIN probe's own classification through even on a
    // successful api-key fallback. Without it, a transient spawn-starved
    // blip on that one probe read identically to an actually-revoked stored
    // login, and buildBillingFallbackAlertPayload told on-call to re-login
    // for a hiccup that needed no action.
    const storedWasStarved = preflight.storedReason === 'spawn-starved' || preflight.storedReason === 'spawn-error';
    const reason = preflight.mode === 'api-key'
      ? (storedWasStarved
        ? `real call succeeded via ANTHROPIC_API_KEY fallback (pay-per-token) — the stored-login probe itself failed to run (${preflight.storedReason}: ${preflight.storedDetail || 'unknown'}), NOT a confirmed revoked credential`
        : `real call succeeded via ANTHROPIC_API_KEY fallback (pay-per-token) — stored OAuth login failed: ${preflight.storedDetail || 'unknown'}`)
      : 'real call succeeded via stored OAuth login';
    return { ok: true, mode: preflight.mode, reason, storedReason: preflight.storedReason || null, authStatusLoggedIn };
  }

  // BRO-2971: preflight.reason ('spawn-starved'|'spawn-error'|'auth-rejected')
  // rides through untouched — this is the ONLY signal buildAlertPayload uses
  // to pick which alert to build. Do not re-derive it from `preflight.detail`
  // text (a reworded error message would silently misroute the page).
  const mode = preflight.reason === 'spawn-starved' || preflight.reason === 'spawn-error' ? preflight.reason : 'fail';
  return {
    ok: false,
    mode,
    reason: `real call failed — ${preflight.detail || 'no working credential'}`,
    authStatusLoggedIn,
  };
}

const REPAIR_STEPS = 'claude auth logout && claude auth login && claude -p "say ok"';
const SPAWN_STARVATION_REPAIR_STEPS = 'free memory (check for the BRO-2789 OOM plateau) or prune cmux sessions (cmux is at/near its ~33-runtime ceiling) — then re-run scripts/check-claude-auth-health.js';
const SPAWN_ERROR_REPAIR_STEPS = 'check that the `claude` binary is installed and executable at the resolved path (CLAUDE_BIN / candidate list in scripts/lib/claude-cli.js) — this is a missing/broken binary, not a credential problem — then re-run scripts/check-claude-auth-health.js';

/**
 * Builds the routeAlert() payload for a failed (or degraded) health result.
 * Pure — never calls routeAlert itself, so it's testable without a network.
 *
 * BRO-2971: a spawn that never reached the auth handshake (ETIMEDOUT/ENOMEM,
 * an OS/jetsam signal kill — exit 143/137, or a missing/broken binary) used to
 * page with THIS function's auth-revocation framing, telling on-call to
 * re-run `claude auth login` for a problem that fix cannot touch.
 * `health.mode` ('spawn-starved'|'spawn-error', set by evaluateAuthHealth from
 * preflight.reason) routes those shapes to their own conditionKey/remediation
 * instead of the credential one.
 */
function buildAlertPayload(health) {
  if (health.mode === 'spawn-starved') {
    return {
      conditionKey: 'claude-spawn-starved',
      title: "Claude spawn failing from resource starvation, not a revoked token",
      description: `check-claude-auth-health.js's real API call never reached the auth handshake: ${health.reason}. This is an OS/jetsam-level spawn failure (timeout, out-of-memory, or a signal kill), not a credential rejection — do NOT re-run \`claude auth login\`. Repair: ${SPAWN_STARVATION_REPAIR_STEPS}`,
      severity: 'error',
      disposition: 'human',
      hint: SPAWN_STARVATION_REPAIR_STEPS,
    };
  }
  if (health.mode === 'spawn-error') {
    return {
      conditionKey: 'claude-spawn-error',
      title: 'Claude spawn failing — binary missing or broken, not a revoked token',
      description: `check-claude-auth-health.js's real API call never reached the auth handshake: ${health.reason}. This looks like a missing or unexecutable \`claude\` binary, not a credential rejection — do NOT re-run \`claude auth login\`. Repair: ${SPAWN_ERROR_REPAIR_STEPS}`,
      severity: 'error',
      disposition: 'human',
      hint: SPAWN_ERROR_REPAIR_STEPS,
    };
  }
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

/**
 * Builds the routeAlert() payload for the "healthy but billing silently
 * switched to pay-per-token" case (stored OAuth login failed, ANTHROPIC_API_KEY
 * fallback covered it). Launches still work, so this is digest-tier, not a
 * page — but it must not be console.warn-only into a launchd log nobody
 * reads (ship-check finding, task #1076): a stale/expired OAuth token that
 * happens to have a working API key fallback would otherwise burn real
 * pay-per-token spend indefinitely with zero owner visibility.
 */
function buildBillingFallbackAlertPayload(health) {
  return {
    conditionKey: 'claude-auth:api-key-fallback',
    title: 'Claude launches are running on pay-per-token, not the subscription',
    description: `check-claude-auth-health.js: ${health.reason}. Launches still work, but billing silently left the subscription. Repair: \`${REPAIR_STEPS}\``,
    severity: 'warning',
    disposition: 'digest',
    hint: REPAIR_STEPS,
  };
}

module.exports = { evaluateAuthHealth, buildAlertPayload, buildBillingFallbackAlertPayload, REPAIR_STEPS, SPAWN_STARVATION_REPAIR_STEPS, SPAWN_ERROR_REPAIR_STEPS };
