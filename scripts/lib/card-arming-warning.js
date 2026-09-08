'use strict';

const fs = require('fs');
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

// Diagnosis hints keyed by evaluateVerifiability()'s `kind`. Kept as data so a
// new kind added to verify-gate.js shows up as a missing key in the test
// rather than as a silently generic message.
const KIND_HINTS = {
  'no-section': 'The card has no "## Acceptance criteria" section and no VERIFY: line at all.',
  'no-command':
    'The acceptance criteria are prose. Prose cannot be re-run, so it cannot prove the work later.',
  shape:
    'The acceptance criteria DO name a command, but it matches none of the allowed safe forms, ' +
    'so the Done gate will refuse this card outright. This is the failure that is easiest to miss: ' +
    'the command can be perfectly correct and still be unusable here.',
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
// silently passing. That is the right failure direction and the wrong outcome:
// crown v50 had to hand-correct two such commands for exactly this reason, and
// a permanently-red recheck trains everyone to ignore the recheck. Found again
// on BRO-2789, whose command named tests/unit/cmux-swap-memory.test.mjs — a
// file that has never existed — which the shape check alone called armed.
// Same defect class as BRO-2977.
const TEST_RUNNER_RE = /^(?:node|npx tsx) --test(?: --test-timeout \d+)?((?: [\w@./-]+)+)$/;

// @returns {string[]} the paths this command names that are NOT present in repoRoot
function missingTestPaths(cmd, repoRoot) {
  const m = TEST_RUNNER_RE.exec(String(cmd || '').trim());
  if (!m) return [];
  return m[1]
    .trim()
    .split(/\s+/)
    .filter((rel) => {
      // Never let a traversal escape the repo while probing.
      if (rel.split('/').includes('..')) return false;
      try {
        return !fs.existsSync(path.join(repoRoot, rel));
      } catch (e) {
        return false;
      }
    });
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
    // Shape-valid, but does the file it names exist?
    const repoRoot = deps.repoRoot || path.resolve(__dirname, '..', '..');
    const missing = missingTestPaths(verdict.cmd, repoRoot);
    if (!missing.length) return null;
    return (
      '\u26a0\ufe0f  ACCEPTANCE COMMAND NAMES A FILE THAT DOES NOT EXIST.\n\n' +
      `  ${verdict.cmd}\n` +
      `Missing: ${missing.join(', ')}\n\n` +
      'The command is a valid safe form, so the shape check passes and the card LOOKS armed.\n' +
      'It is not. `node --test <missing path>` prints "Could not find ..." and exits 1, which\n' +
      "acceptance-check-core.js's runVerify() reports as 'fail' — so once this card is marked\n" +
      'Done its nightly recheck goes red forever, for a reason that has nothing to do with the\n' +
      'work. A permanently-red recheck is how a real regression gets ignored.\n\n' +
      'If the test file is something this card WILL create, that is fine and expected — but come\n' +
      'back once the work lands and replace the command with the real filename. A card armed\n' +
      'against an invented filename is worse than one that is honestly unarmed.\n\n' +
      'The card was still saved.'
    );
  }

  if (!verdict) return null;

  const hint = KIND_HINTS[verdict.kind] || '';

  // For kind 'shape' the offending command is the single most useful thing to
  // print, so name it and say exactly which check it failed.
  let offending = '';
  if (verdict.kind === 'shape') {
    let cmd = null;
    try {
      cmd = (gate.candidatesFrom(notesStr) || [])[0] || null;
    } catch (e) {
      cmd = null;
    }
    if (cmd) {
      let why = null;
      try {
        why = gate.explainUnsafeCheckCommand(cmd);
      } catch (e) {
        why = null;
      }
      offending =
        `\nThe command it found:  ${cmd}\n` +
        `Rejected as:           ${(why && why.kind) || 'unsafe'}` +
        (why && why.reason ? `\nReason:                ${why.reason}` : '') +
        '\n';
    }
  }

  return (
    '⚠️  ACCEPTANCE CRITERIA DO NOT ARM — this card cannot be closed as filed.\n\n' +
    `${verdict.reason}\n` +
    (hint ? `${hint}\n` : '') +
    offending +
    `\n${SAFE_FORM_EXAMPLES}\n\n` +
    "If this card's outcome truly cannot be machine-checked (a decision, an email, a design),\n" +
    'add the line:\n' +
    '  VERIFY: owner-judgment\n' +
    'so the unverifiability is DECLARED rather than accidental — that arms the card too.\n\n' +
    'The card was still saved. Edit its description to fix this now; the Done gate will refuse\n' +
    'the completed transition until you do.'
  );
}

module.exports = { armingWarning, missingTestPaths, KIND_HINTS, SAFE_FORM_EXAMPLES, TEST_RUNNER_RE };
