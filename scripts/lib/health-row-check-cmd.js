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

// Both sides of this contract — the encoder here and the comparison in
// scripts/check-health-row-absent.js — must truncate the row name to the SAME
// bound, or a long name encodes to a token that silently never matches.
const ROW_NAME_MATCH_LIMIT = 120;

// The generated token also has to survive SAFE_CHECK_FORMS' own bound, which
// is what actually decides whether the acceptance command is a legal safe form
// at all: autonomous-triage-core.js's
//   /^node scripts\/check-health-row-absent\.js --row-b64 ([A-Za-z0-9_-]{1,200})( --live)?$/
// The old comment here claimed 120 chars was "≤160 b64 chars even for
// multi-byte", which is wrong: base64url of N bytes is ceil(N*4/3) chars, so
// 120 three-byte characters encode to 480 — well past the cap. The command
// would then fail the safe-form gate and the card would be UNDISPATCHABLE,
// which is the exact failure BRO-3881 exists to stop (ship-check/Codex
// finding, 2026-09-20). No row name in the live snapshot is anywhere near
// this today (longest is 53 ASCII characters), so the clamp below is a trap
// closed rather than a behaviour change — but this is precisely the kind of
// trap that only ever fires unattended.
const SAFE_TOKEN_MAX_CHARS = 200;

/**
 * The canonical truncated form of a health-check row name — the string that
 * gets encoded, and the string the checker compares on BOTH sides. Exported so
 * scripts/check-health-row-absent.js uses this function rather than its own
 * copy of the bound (it previously re-declared `const LIMIT = 120` and the two
 * could drift silently).
 *
 * @param {string} name
 * @returns {string}
 */
function rowMatchKey(name) {
  let key = String(name == null ? '' : name).trim().slice(0, ROW_NAME_MATCH_LIMIT);
  // Drop one character at a time rather than computing a byte budget: the cut
  // has to land on a character boundary the decoder can round-trip, and a
  // name long enough to need this is rare enough that the loop is free.
  while (key && Buffer.from(key, 'utf8').toString('base64url').length > SAFE_TOKEN_MAX_CHARS) {
    key = key.slice(0, -1);
  }
  return key;
}

/**
 * Encode one health-check row's RAW name into the check-health-row-absent.js
 * safe-form command. Callers pass the raw name, never a prose-sanitized one —
 * the checker compares against raw snapshot names.
 *
 * @param {string} name health-check row name, e.g. "Data quality: provider spend ledger"
 * @returns {string} a backtickable, SAFE_CHECK_FORMS-passing command
 */
function rowAbsentCheckCmd(name) {
  return `node scripts/check-health-row-absent.js --row-b64 ${Buffer.from(rowMatchKey(name), 'utf8').toString('base64url')}`;
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


/**
 * Row/condition text made safe to interpolate into an auto-filed card body.
 *
 * Shared by BOTH auto-filers (BRO-3881 ship-check finding): digest-autofix.js
 * has always routed this text through here, but owner-alert-router.js
 * interpolated it raw — and the text it interpolates now sits in the same
 * "## Acceptance criteria" section as a real backticked command. A row name
 * containing a backtick would open a second backticked span in that section,
 * and autonomous-verify-cmd.js's candidatesFrom is a matchAll over every
 * backticked span with a rank-then-first selection — so a crafted span could
 * DISPLACE the real acceptance command. A literal "VERIFY:" in row text is the
 * same hazard against extractVerifyCmd. No live row name contains either
 * today; this closes it before one does.
 */
function sanitizeRowText(s) {
  return String(s || '')
    .replace(/`/g, "'")
    .replace(/^#+\s/gm, '')
    .replace(/VERIFY\s*:/gi, 'VERIFY -');
}

module.exports = { rowAbsentCheckCmd, rowMatchKey, sanitizeRowText, healthRowNameFromConditionKey, HEALTH_CHECK_PREFIX, ROW_NAME_MATCH_LIMIT, SAFE_TOKEN_MAX_CHARS };
