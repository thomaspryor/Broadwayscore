/**
 * The one place that builds a `check-health-row-absent.js` acceptance command.
 *
 * BRO-3881: this used to live privately inside scripts/lib/digest-autofix.js,
 * so the OTHER auto-filer — scripts/lib/owner-alert-router.js — wrote prose
 * acceptance criteria instead ("Condition X no longer fires on the next
 * check"). Prose does not satisfy evaluateVerifiability() (scripts/lib/
 * verify-gate.js), which is the gate linear-next.js runs before every
 * dispatch, so every card the router filed was refused the moment the digest
 * tried to work it:
 *
 *   [linear-next] REFUSING to dispatch BRO-3349: no runnable verify command
 *   (acceptance criteria names no runnable command (prose only)).
 *
 * That refusal happens inside the DETACHED child, after the parent has already
 * spent a dispatch slot and journalled the attempt, so from the digest's side
 * it looks exactly like a real dispatch. BRO-3349 was picked and refused on
 * four consecutive days (2026-09-17 through 2026-09-20) — one of only two
 * daily slots, doing nothing, every day.
 *
 * Shared rather than copied (CLAUDE.md rule 15): the encoding has to round-trip
 * to exactly what check-health-row-absent.js compares against, and a second
 * hand-written copy of that contract is how the two filers drifted in the first
 * place.
 */

// The b64url token must fit SAFE_CHECK_FORMS' 200-char cap AND decode back to
// exactly what check-health-row-absent.js compares — so BOTH sides slice the
// row name to the same bound (120 chars ≈ ≤160 b64 chars even for multi-byte).
const ROW_NAME_MATCH_LIMIT = 120;

/**
 * Encode one health-check row's RAW name into the check-health-row-absent.js
 * safe-form command. Callers pass the raw name, never a prose-sanitized one —
 * the checker compares against raw snapshot names.
 *
 * @param {string} name health-check row name, e.g. "Data quality: provider spend ledger"
 * @returns {string} a backtickable, SAFE_CHECK_FORMS-passing command
 */
function rowAbsentCheckCmd(name) {
  return `node scripts/check-health-row-absent.js --row-b64 ${Buffer.from(String(name).trim().slice(0, ROW_NAME_MATCH_LIMIT), 'utf8').toString('base64url')}`;
}

/**
 * The health-check conditionKey prefix owner-alert-router.js stamps on rows
 * that came from scripts/health-check.js. A key of
 * `health-check:Data quality: provider spend ledger` carries the row name
 * after the FIRST colon only — row names contain colons of their own, so this
 * deliberately splits once rather than on every colon.
 *
 * @param {string} conditionKey
 * @returns {string|null} the health-check row name, or null if not one
 */
const HEALTH_CHECK_PREFIX = 'health-check:';
function healthRowNameFromConditionKey(conditionKey) {
  const key = String(conditionKey || '');
  if (!key.startsWith(HEALTH_CHECK_PREFIX)) return null;
  const name = key.slice(HEALTH_CHECK_PREFIX.length).trim();
  return name || null;
}

module.exports = { rowAbsentCheckCmd, healthRowNameFromConditionKey, HEALTH_CHECK_PREFIX, ROW_NAME_MATCH_LIMIT };
