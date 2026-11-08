'use strict';
/**
 * BRO-7138: tell "the check could not run on this machine" apart from "the
 * fix stopped working".
 *
 * runVerify (acceptance-check-core.js) runs a card's own VERIFY command in a
 * fresh checkout with a stripped environment: checksEnv() withholds every
 * token on purpose, and prepareCheckWorkdir() copies core JSON but never the
 * private review texts. A command that needs one of those fails EVERY night,
 * whatever the state of the fix. Counting that as "the fix broke" made the
 * nightly recheck report ~18 false failures out of 85 (2026-10-09..11-08).
 *
 * Each cause below is anchored on a string only the environment produces,
 * never on a generic "Cannot find module" (a genuinely deleted module is a
 * real regression and must stay a fail). Measured on the real ledger rows in
 * scripts/lib/fixtures/recheck-real-fails-2026-11.jsonl (check-env-cause.test.mjs).
 *
 * Builtins only: required by the check runner, which stays dependency-free.
 */

const CAUSES = [
  {
    key: 'credential-withheld',
    // checksEnv() strips GH_TOKEN, LINEAR_API_KEY and every other secret.
    re: /gh auth login|populate the GH_TOKEN environment variable|gh api fetch failed|\b[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET)\b[^\n]{0,40}?\bnot set\b/,
    plain: 'its check needs a password the recheck machine is not given',
  },
  {
    key: 'private-texts-absent',
    // The review texts are a private repo the check workdir never receives.
    re: /data\/review-texts (?:is missing|not found)/,
    plain: 'its check needs the private review texts, which the recheck machine does not have',
  },
  {
    key: 'generated-manifest-absent',
    // Gitignored files built by build-cast-manifest.js / build-actor-slugs-manifest.js.
    re: /TS2307: Cannot find module '[^']*data\/(?:cast-manifest|actor-slugs)\.json'/,
    plain: 'its check needs a generated data file the recheck machine had not built',
  },
  {
    key: 'ts-under-plain-node',
    re: /Unknown file extension "\.tsx?"/,
    plain: 'its check was run with the wrong test runner',
  },
];

const LOADER_ERROR_RE = /ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND/;

/** Test files a `node --test ...` argv names (flags dropped). */
function nodeTestFiles(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'node' || !argv.includes('--test')) return [];
  return argv.slice(1).filter((a) => !a.startsWith('-'));
}

/**
 * True when this is `node --test` over files CI runs under `npx tsx --test`
 * (tests/unit-test-manifest-tsx.txt + e2e manifest). Plain node cannot load
 * the .ts they import, so it fails whatever the fix's state.
 */
function needsTsxRunner(argv, tsxTests) {
  const files = nodeTestFiles(argv);
  return files.length > 0 && !!tsxTests && files.every((f) => tsxTests.has(f));
}

/**
 * The environment cause of a failed check, or null when the failure is real.
 * @param {string} detail  the failing output (any length; the ledger keeps 300 chars)
 * @param {{argv?:string[], tsxTests?:Set<string>}} [ctx]
 * @returns {{key:string, plain:string}|null}
 */
function envCauseOf(detail, { argv = null, tsxTests = null } = {}) {
  const text = String(detail || '');
  if (!text) return null;
  for (const c of CAUSES) if (c.re.test(text)) return { key: c.key, plain: c.plain };
  // A loader error on a tsx-manifest test is the wrong runner, not a missing
  // module. Without the manifest match this stays a real fail.
  if (LOADER_ERROR_RE.test(text) && needsTsxRunner(argv, tsxTests)) {
    const c = CAUSES.find((x) => x.key === 'ts-under-plain-node');
    return { key: c.key, plain: c.plain };
  }
  return null;
}

let defaultTsxTests = null;
function repoTsxTests() {
  if (!defaultTsxTests) {
    try { defaultTsxTests = require('./autonomous-checks.js').readTsxRunTests(require('path').join(__dirname, '..', '..')); }
    catch { defaultTsxTests = new Set(); }
  }
  return defaultTsxTests;
}

/**
 * The verdict of one recheck ledger row, the same way for old and new rows.
 * Rows written after runVerify learned envCause carry it (status
 * 'unverifiable'); older rows say 'fail' and are reclassified from their
 * detail and verifyCmd. Every ledger reader (heldShare, the board report, the
 * watchdog, the morning email) goes through this.
 * @param {object} row  a ledger 'recheck' row
 * @param {{tsxTests?:Set<string>}} [o]  defaults to this repo's tsx manifests
 * @returns {{status:string|null, envCause:string|null}}
 */
function recheckVerdict(row, { tsxTests } = {}) {
  if (!row || !row.status) return { status: row ? row.status || null : null, envCause: null };
  if (row.envCause) return { status: 'unverifiable', envCause: row.envCause };
  if (row.status !== 'fail') return { status: row.status, envCause: null };
  let argv = null;
  try { argv = row.verifyCmd ? require('./autonomous-checks.js').tokenizeCheckCommand(String(row.verifyCmd)) : null; } catch { argv = null; }
  const cause = envCauseOf(row.detail || row.note, { argv, tsxTests: tsxTests === undefined ? repoTsxTests() : tsxTests });
  return cause ? { status: 'unverifiable', envCause: cause.key } : { status: 'fail', envCause: null };
}

const PLAIN_BY_KEY = Object.fromEntries(CAUSES.map((c) => [c.key, c.plain]));
function plainEnvCause(key) { return PLAIN_BY_KEY[key] || 'its check could not run on the recheck machine'; }

module.exports = { envCauseOf, recheckVerdict, needsTsxRunner, nodeTestFiles, plainEnvCause, ENV_CAUSE_KEYS: CAUSES.map((c) => c.key) };
