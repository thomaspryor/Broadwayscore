/**
 * owner-judgment-marker.js — the one definition of the "VERIFY: owner-judgment"
 * marker, and nothing else.
 *
 * A card carries this marker when its outcome cannot be machine-checked: only
 * the owner can look at the result and say whether it is right. Three separate
 * layers need to recognise it and they sit at different depths of the require
 * graph:
 *
 *   verify-gate.js              — the marker ARMS an otherwise-unverifiable card
 *   headless-dispatchability.js — the marker BLOCKS an unattended dispatch
 *   autonomous-eligibility.js   — the marker EXCLUDES the card from auto-pick
 *
 * They cannot share the regex through any of those modules, because
 * verify-gate.js -> autonomous-triage-core.js -> autonomous-eligibility.js is
 * already a chain: adding an edge back from autonomous-eligibility.js to
 * verify-gate.js closes a cycle, and CommonJS resolves a cycle by handing one
 * side a half-built `module.exports` — whichever module was require()d second
 * silently sees `undefined` for the other's functions, for the lifetime of the
 * process. autonomous-shadow-run.js requires them in exactly the order that
 * would break isSafeCheckCommand inside evaluateVerifiability.
 *
 * So this file is a LEAF: it requires nothing, and every layer above requires
 * it. Keeping it dependency-free is the whole point — do not add imports here.
 *
 * Task #1154 (2026-08-09). Before this file existed the regex was written out
 * twice: verify-gate.js's OWNER_JUDGMENT_RE and headless-dispatchability.js's
 * copy inside OWNER_DECISION_RES.
 */

'use strict';

// No `g`/`y` flag on purpose: a stateless regex can be shared across modules
// and across .test()/.exec() calls without a lastIndex carrying over.
//
// Deliberately unanchored, and deliberately unchanged from the form
// verify-gate.js has always used. It therefore also matches a card that merely
// DISCUSSES the marker in prose — card #1154, which created this file, excludes
// itself. That over-match predates this module (such a card already counted as
// "armed" at the verify gate), it is the safe direction for a default-deny
// predicate, and anchoring it here would silently change which cards
// verify-gate considers armed.
const OWNER_JUDGMENT_RE = /VERIFY:\s*owner-judgment/i;

/**
 * Does this text declare the card owner-judgment? Accepts anything stringable
 * (card notes, a task-mirror description, null) — callers pass untrusted card
 * text and should not have to null-guard first.
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function hasOwnerJudgmentMarker(text) {
  return OWNER_JUDGMENT_RE.test(String(text || ''));
}

module.exports = { OWNER_JUDGMENT_RE, hasOwnerJudgmentMarker };
