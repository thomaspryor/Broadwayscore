/**
 * Shared `--max=N` ceiling parser for the audit/gate scripts.
 *
 * Every gate script had hand-rolled this as
 *   `maxArg ? parseInt(maxArg.split('=')[1], 10) : DEFAULT`
 * which hands back NaN for `--max=abc` and `--max=`. Every one of those gates
 * then compares `hits.length > max`, and `anything > NaN` is ALWAYS false — so
 * a single typo in a workflow silently converts a blocking gate into a no-op
 * that still prints a passing summary. `audit-self-contradictory-clears.js`
 * runs in test.yml at `--max=780`; a typo there would have disabled it with no
 * signal whatsoever.
 *
 * Centralised so the next gate that needs a ceiling cannot reintroduce the
 * hole by copying the old one-liner (the copy is exactly how this spread to
 * six scripts).
 *
 * Rejects, rather than coercing:
 *   --max=abc  --max=  --max=1.5  --max=-1  --max=15x  --max   (bare, no '=')
 *
 * @param {string[]} argv - argument list (without node/script)
 * @param {object} [opts]
 * @param {number} [opts.defaultMax=0] - value when no --max is supplied
 * @param {string} [opts.scriptName] - name used in the error message
 * @returns {number} the parsed non-negative integer ceiling
 * @throws {MaxArgError} when a --max is present but not a non-negative integer
 */
class MaxArgError extends Error {}

function parseMaxArg(argv, { defaultMax = 0, scriptName = '' } = {}) {
  const list = Array.isArray(argv) ? argv : [];
  // A bare `--max` (no '=') never matched the old startsWith('--max=') check,
  // so it silently fell through to the default — a ceiling the operator
  // believed they had set. Treat it as the error it is.
  if (list.includes('--max')) {
    throw new MaxArgError(
      `${scriptName ? `${scriptName}: ` : ''}--max requires a value, e.g. --max=15`
    );
  }
  const matches = list.filter((a) => a.startsWith('--max='));
  if (!matches.length) return defaultMax;
  // Two ceilings is always an authoring mistake, and silently taking the first
  // is the same class of failure as the NaN hole: `--max=60 --max=0` reads as
  // "0" to whoever edits the workflow next while actually gating at 60 (and
  // the reverse silently weakens the gate). Refuse to guess.
  if (matches.length > 1) {
    throw new MaxArgError(
      `${scriptName ? `${scriptName}: ` : ''}--max given ${matches.length} times (${matches.join(' ')}); pass exactly one.`
    );
  }

  const raw = matches[0].slice('--max='.length);
  if (!/^\d+$/.test(raw)) {
    throw new MaxArgError(
      `${scriptName ? `${scriptName}: ` : ''}--max must be a non-negative integer, got "${raw}". ` +
      'A non-numeric ceiling silently disables the gate (hits > NaN is always false), so this is fatal.'
    );
  }
  const n = Number(raw);
  // Beyond 2^53 the decimal text and the Number stop agreeing, so the ceiling
  // enforced would differ from the one written. No real gate is near this, but
  // a silently-rounded ceiling is exactly the failure mode being closed here.
  if (!Number.isSafeInteger(n)) {
    throw new MaxArgError(
      `${scriptName ? `${scriptName}: ` : ''}--max=${raw} exceeds the safe integer range; the enforced ceiling would not match the value given.`
    );
  }
  return n;
}

/**
 * CLI wrapper: parse, or print the error and exit 2. Exit 2 is deliberately
 * distinct from the exit 1 that gates use for "corpus failed the check", so a
 * malformed invocation can never be mistaken for either a pass or a real
 * finding.
 */
function parseMaxArgOrExit(argv, opts = {}) {
  try {
    return parseMaxArg(argv, opts);
  } catch (e) {
    if (!(e instanceof MaxArgError)) throw e;
    console.error(`FAIL: ${e.message}`);
    process.exit(2);
    // Unreachable in normal use, but process.exit is stubbable (test harnesses,
    // exit hooks). Without this the function would return undefined and every
    // caller's `count > undefined` would be false — reinstating the exact
    // silent-disable bug this module exists to close. Fail loud instead.
    throw e;
  }
}

module.exports = { parseMaxArg, parseMaxArgOrExit, MaxArgError };
