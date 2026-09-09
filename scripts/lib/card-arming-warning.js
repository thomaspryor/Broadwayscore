'use strict';

const path = require('path');
/**
 * card-arming-warning.js — the creation-time "this card cannot be closed"
 * warning, shared by BOTH board chokepoints.
 *
 * The acceptance criteria must ARM the verification chain. A dispatcher
 * captures ONE backticked command at dispatch (scripts/lib/autonomous-verify-
 * cmd.js), the Done gate (scripts/lib/linear-done-gate.js) refuses a
 * completed-type transition without one, and the nightly acceptance recheck
 * re-runs it after the card is marked Done. A card filed with criteria that do
 * not arm is un-closable by construction, and nobody finds out until somebody
 * tries to close it — possibly weeks later.
 *
 * WARN, DON'T REJECT. Automated card creators (owner-alert-router.js,
 * digest-autofix.js, ux-walkthrough.mjs) file cards with generated prose; a
 * hard reject here would silently break the alert->card chain. The HARD stop
 * lives downstream at dispatch and at the Done gate. Returns null when the
 * card is armed or has explicitly declared owner-judgment.
 *
 * WHY THIS IS A SHARED LIB AND NOT A COPY (BRO-3060, 2026-09-08): this check
 * lived only inside scripts/notion-brain.js. scripts/linear-brain.js — the
 * Linear-side chokepoint that REPLACES it, and the one every session is now
 * told to use — never had it. Measured on the live board the day this moved:
 * of 1103 open issues, 17 carry an acceptance section whose command matches no
 * SAFE_CHECK_FORMS entry (all 17 diagnose as kind 'shape'), 15 have a section
 * with no extractable command, and 5 have no section at all. BRO-3060 was one
 * of the 17 — armed with `node scripts/linear-drain-parked.js --dry-run`, a
 * real and correct command that no safe form accepts, so its Done transition
 * was refused outright and the nightly recheck would have reported it failing
 * forever. Porting the check by copy-paste would have re-created the same
 * divergence one migration later, so both callers require() this instead.
 */

// Diagnosis hints keyed by evaluateVerifiability()'s `kind`. verify-gate.js's
// header documents SEVEN: 'no-section' | 'no-command' | 'shape' |
// 'path-prefix' | 'traversal' | 'mutating-script' | 'basename' (BRO-2570).
// An earlier version of this file covered three, so a card refused for
// 'path-prefix' or 'traversal' got the generic message with no explanation of
// what was actually wrong — and the test meant to catch that hard-coded the
// same three kinds, so it passed while 4 of 7 were unhandled. The test now
// derives the list from verify-gate.js's own documented set.
const KIND_HINTS = {
  'no-section': 'The card has no "## Acceptance criteria" section and no VERIFY: line at all.',
  'no-command':
    'The acceptance criteria are prose. Prose cannot be re-run, so it cannot prove the work later.',
  shape:
    'The acceptance criteria DO name a command, but it matches none of the allowed safe forms, ' +
    'so the Done gate will refuse this card outright. This is the failure that is easiest to miss: ' +
    'the command can be perfectly correct and still be unusable here.',
  'path-prefix':
    'The command has an allowed SHAPE but points at a file outside the directories a check may ' +
    'read. Acceptance commands may only name paths under tests/, scripts/ or src/ (plus docs/ and ' +
    'memory/ for the `test -f` form) — a check that reads data/ or public/ would be measuring the ' +
    'corpus rather than the work.',
  traversal:
    'The command contains a `..` path segment. It is refused whatever it resolves to, because an ' +
    'acceptance command is re-run unattended by the nightly recheck and must not be able to reach ' +
    'outside the repository.',
  'mutating-script':
    'The command has an allowed shape but names a script that WRITES to the corpus (shows.json, ' +
    'reviews.json, review-texts). An acceptance check is re-run long after the card closes, so it ' +
    'has to be read-only — otherwise verifying a card silently mutates production data.',
  basename:
    'The command names a script that is not on the vetted read-only allowlist. Only scripts ' +
    'individually checked as corpus-safe may be used as acceptance checks; add yours to ' +
    "autonomous-triage-core.js's list, with the reasoning, if it genuinely qualifies.",
};

const SAFE_FORM_EXAMPLES =
  'Allowed safe forms (scripts/lib/autonomous-triage-core.js SAFE_CHECK_FORMS):\n' +
  '  - `node --test tests/unit/thing.test.mjs` (a test file the work adds or extends)\n' +
  '  - `npx tsx --test tests/unit/thing.test.ts` (when the test imports a TS module)\n' +
  '  - `npx tsc --noEmit` / `npx next lint`\n' +
  '  - `test -f scripts/new-file.js`\n' +
  'Note what is NOT allowed: an arbitrary `node scripts/whatever.js --flag` invocation, a bare\n' +
  'file path, a grep, or a source location like `scripts/foo.js:80`. Check your command with\n' +
  "isSafeCheckCommand() from scripts/lib/verify-gate.js BEFORE filing, not after.";

// A command can pass safe-form and STILL be useless: `node --test
// tests/unit/nope.test.mjs` is a perfectly valid shape naming a file that does
// not exist. Node exits 1 there ("Could not find ..."), and
// acceptance-check-core.js's runVerify() reports that as status 'fail' — so a
// card armed this way reports FAILING forever once it is marked Done, not
// silently passing. Crown v50 had to hand-correct two such commands, and a
// permanently-red recheck trains everyone to ignore the recheck.
//
// BUT "the path does not exist" is NOT by itself a defect, and this must not
// re-litigate that. autonomous-triage-core.js's NEW-ARTIFACT ALLOWANCE
// (card #529, 2026-07-26) settled it after a measured incident: vetoing every
// missing path killed 3 in-scope cards in one live run, purely because their
// proof command named the test they were going to write. This repo's own
// convention (CLAUDE.md rule 15) is that a fix ships WITH its new colocated
// test, so naming a to-be-created file is CORRECT.
//
// So this delegates to resolveCheckPaths() rather than re-implementing the
// rule — the "must match X" comment IS the bug, per
// memory/feedback_includability_predicates_must_be_canonical.md. It warns only
// on what that function already fails closed: a path whose PARENT DIRECTORY
// does not exist (a fabricated location), or one naming a real DIRECTORY
// rather than a file. A missing file in a real directory comes back in
// `newPaths` and is deliberately silent.
//
// Delegating also inherits two things this file got wrong on its own: the
// canonical probe uses statSync().isFile() (existsSync happily accepts a
// directory, or a symlink pointing outside the repo), and extractCheckPaths()
// derives paths from SAFE_CHECK_FORMS instead of a looser local regex that
// treated arbitrary extensions and flag-looking tokens as paths.

// @returns {{reason:string}|null} a fabricated-location diagnosis, or null
function fabricatedPathReason(cmd, repoRoot, deps = {}) {
  let core = deps.triageCore;
  if (!core) {
    try {
      core = require('./autonomous-triage-core.js');
    } catch (e) {
      return null; // fail open, same contract as the validator-unavailable path
    }
  }
  try {
    const r = core.resolveCheckPaths(String(cmd || ''), { repoRoot });
    if (r && r.ok === false && r.reason) return { reason: r.reason };
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} notesStr the card's description/notes as filed
 * @param {object} [deps] injection seam for tests
 * @returns {string|null} a human-readable warning, or null when armed
 */
function armingWarning(notesStr, deps = {}) {
  let gate = deps.verifyGate;
  if (!gate) {
    try {
      gate = require('./verify-gate.js');
    } catch (e) {
      // Validator module unavailable (partial checkout): never block card
      // creation on our own tooling being missing.
      return null;
    }
  }

  let verdict;
  try {
    verdict = gate.evaluateVerifiability(notesStr);
  } catch (e) {
    return null;
  }
  if (verdict && verdict.ownerJudgment) return null;

  if (verdict && verdict.armed) {
    // Shape-valid — but does it name a location that could ever exist?
    const repoRoot = deps.repoRoot || path.resolve(__dirname, '..', '..');
    const bad = fabricatedPathReason(verdict.cmd, repoRoot, deps);
    if (!bad) return null;
    return (
      '\u26a0\ufe0f  ACCEPTANCE COMMAND NAMES A LOCATION THAT DOES NOT EXIST.\n\n' +
      `  ${verdict.cmd}\n` +
      `  ${bad.reason}\n\n` +
      'The command is a valid safe form, so the shape check passes and the card LOOKS armed.\n' +
      'It is not. `node --test <bad path>` prints "Could not find ..." and exits 1, which\n' +
      "acceptance-check-core.js's runVerify() reports as 'fail' — so once this card is marked\n" +
      'Done its nightly recheck goes red forever, for a reason that has nothing to do with the\n' +
      'work. A permanently-red recheck is how a real regression gets ignored.\n\n' +
      'Naming a test file this card WILL CREATE is correct and does NOT trigger this warning —\n' +
      'the parent directory just has to exist. This fires only when the directory itself is\n' +
      'fabricated, or when the path names a directory rather than a file.\n\n' +
      'The card was still saved.'
    );
  }

  if (!verdict) return null;

  const hint = KIND_HINTS[verdict.kind] || '';


  // NOTE: do NOT re-derive the offending command here. An earlier version
  // called candidatesFrom(notesStr), which is a raw backtick scanner over the
  // WHOLE note (autonomous-verify-cmd.js:45) — the acceptance-section scoping
  // lives in extractVerifyCmd, not in it. So a backticked span anywhere in
  // "## Problem" was reported as the offender: a card whose real problem was
  // `node scripts/linear-drain-parked.js --dry-run` printed
  // "The command it found: npx tsc --noEmit" purely because its Problem
  // section mentioned tsc. verdict.reason is built by verify-gate from the
  // correctly SECTIONED candidates and already names the right one, so quote
  // that and nothing else. Third time this session that re-deriving a value
  // the canonical module already computed produced a wrong answer.

  return (
    '⚠️  ACCEPTANCE CRITERIA DO NOT ARM — this card cannot be closed as filed.\n\n' +
    `${verdict.reason}\n` +
    (hint ? `${hint}\n` : '') +
    `\n${SAFE_FORM_EXAMPLES}\n\n` +
    "If this card's outcome truly cannot be machine-checked (a decision, an email, a design),\n" +
    'add the line:\n' +
    '  VERIFY: owner-judgment\n' +
    'so the unverifiability is DECLARED rather than accidental — that arms the card too.\n\n' +
    'The card was still saved. Edit its description to fix this now; the Done gate will refuse\n' +
    'the completed transition until you do.'
  );
}

module.exports = { armingWarning, fabricatedPathReason, KIND_HINTS, SAFE_FORM_EXAMPLES };
