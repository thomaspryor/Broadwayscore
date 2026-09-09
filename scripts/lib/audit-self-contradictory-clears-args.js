// Argument parsing for scripts/audit-self-contradictory-clears.js.
//
// Extracted to a lib (BRO-2705) for two reasons. First, so the test can
// require() the REAL parser instead of restating its rules — a copy in the test
// would keep passing while the script drifted. Second, because the bug that
// prompted this lives entirely in the parser, not in the remediation logic.
//
// THE BUG: `--dry-run` was never a recognised flag. The old loop matched only
// the flags it knew and silently ignored everything else, so
// `--fix-safe --dry-run` parsed identically to a bare `--fix-safe` and wrote
// the corpus. That matters more here than it would in most scripts: this
// repo's standing rule is that the plain `--fix` on this script is UNTRUSTED
// (it excluded 438 live-scored reviews in August 2026), and `--dry-run` is
// exactly how an operator inspects a remediation they distrust. The inspection
// WAS the mutation.
//
// PREVENTION, not just the fix: an unrecognised argument is now a hard error
// rather than a silent no-op. That covers BARE WORDS as well as `--flags`:
// this script takes no positional arguments, so `--fix-safe dry-run` (a shell
// that ate the dashes, or a hand-typed flag missing them) would otherwise sail
// through and run the real corpus write — the identical failure, one token
// shape over. /code-review caught that the first version of this file only
// closed half the class.
const { parseMaxArgOrExit } = require('./parse-max-arg.js');

// Value-bearing flags are matched by prefix, so they are listed separately from
// the bare switches. Keep both lists in sync with the parser below — the
// unknown-argument check reads them, so an unlisted-but-parsed flag would
// reject itself on the next run.
const BARE_FLAGS = new Set([
  '--gate',
  '--fix',
  '--fix-safe',
  '--dry-run',
  '--json',
  '--record-baseline',
  '--baseline',
]);

// `--help=` mirrors cli-help.js's hasHelpFlag, which accepts `--help=1`
// (task #260). Unreachable from the current caller, which returns on help
// before parsing, but the two must not disagree about what a help flag is.
const VALUE_FLAG_PREFIXES = ['--baseline=', '--show=', '--max=', '--help='];

const HELP_FLAGS = new Set(['--help', '-h']);

function isKnownFlag(a) {
  if (BARE_FLAGS.has(a) || HELP_FLAGS.has(a)) return true;
  return VALUE_FLAG_PREFIXES.some((p) => a.startsWith(p));
}

/**
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {string} [opts.defaultBaselinePath] path a bare `--baseline` resolves
 *   to. Passed explicitly rather than held in a module-level singleton: a
 *   singleton made the exported parser publicly callable in a half-configured
 *   state, and a second consumer would clobber the first's path
 *   (/code-review, 2026-09-01).
 * @param {function} [opts.onUnknown] test seam; production omits it and gets
 *   the exit-2 behaviour.
 */
function parseArgs(argv, { defaultBaselinePath = null, onUnknown } = {}) {
  // --max via the shared parser: the old inline parseInt returned NaN for
  // `--max=abc`/`--max=`, and `unhandled > NaN` is always false, which would
  // have silently disabled this gate. test.yml now gates on --baseline instead,
  // but --max is still the fallback path whenever --baseline is absent, so the
  // NaN-safety it provides still matters.
  const args = {
    gate: false,
    max: parseMaxArgOrExit(argv, { scriptName: 'audit-self-contradictory-clears' }),
    fix: false,
    fixSafe: false,
    dryRun: false,
    show: null,
    json: false,
    baseline: null,
    recordBaseline: false,
  };
  const unknown = [];
  for (const a of argv) {
    if (a === '--gate') args.gate = true;
    else if (a === '--fix') args.fix = true;
    else if (a === '--fix-safe') args.fixSafe = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--record-baseline') args.recordBaseline = true;
    else if (a === '--baseline') args.baseline = defaultBaselinePath;
    else if (a.startsWith('--baseline=')) args.baseline = a.slice('--baseline='.length);
    else if (a.startsWith('--show=')) args.show = a.split('=')[1];
    else if (!isKnownFlag(a)) unknown.push(a);
  }

  const refuse = (message, offenders) => {
    if (typeof onUnknown === 'function') return onUnknown(message, offenders);
    console.error(message);
    process.exit(2);
  };

  if (unknown.length) {
    const known = [...BARE_FLAGS, ...VALUE_FLAG_PREFIXES.map((p) => `${p}<value>`)].sort();
    return refuse(
      `Unrecognised argument(s): ${unknown.join(', ')}\n` +
        `Known flags: ${known.join(' ')}\n` +
        'This script takes no positional arguments. Refusing to run: a silently-ignored ' +
        'argument here can turn an inspection into a corpus write (BRO-2705).',
      unknown,
    );
  }

  // A bare `--baseline` resolves through defaultBaselinePath. Without one the
  // old shape handed back `baseline: null`, which reads downstream as "no
  // baseline requested" — the gate silently stops gating on the very flag CI
  // passes to arm it. Same silent-misconfiguration class as the --dry-run bug,
  // so it fails loudly instead (GPT-4o review, 2026-09-01).
  if (argv.includes('--baseline') && !args.baseline) {
    return refuse(
      'Bare --baseline was passed but no default baseline path is configured. ' +
        'Pass { defaultBaselinePath } to parseArgs(), or use --baseline=<path>. ' +
        'Refusing to run rather than silently gate on nothing (BRO-2705).',
      ['--baseline'],
    );
  }

  return args;
}

module.exports = {
  parseArgs,
  isKnownFlag,
  BARE_FLAGS,
  VALUE_FLAG_PREFIXES,
};
