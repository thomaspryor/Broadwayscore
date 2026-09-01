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
// PREVENTION, not just the fix: an unrecognised `--flag` is now a hard error
// rather than a silent no-op. A typo'd or renamed flag can no longer read as
// "the safe thing happened". That is the class this bug belongs to, and it is
// cheap to close here because the only CI caller passes `--gate --baseline`.
const { parseMaxArgOrExit } = require('./parse-max-arg.js');

// Value-bearing flags are matched by prefix, so they are listed separately from
// the bare switches. Keep both lists in sync with the parser below — the
// unknown-flag check reads them, so an unlisted-but-parsed flag would reject
// itself on the next run.
const BARE_FLAGS = new Set([
  '--gate',
  '--fix',
  '--fix-safe',
  '--dry-run',
  '--json',
  '--record-baseline',
  '--baseline',
]);

const VALUE_FLAG_PREFIXES = ['--baseline=', '--show=', '--max='];

// --help/-h are consumed by hasHelpFlag() in the caller before parseArgs runs,
// but they must not trip the unknown-flag check on the way past.
const HELP_FLAGS = new Set(['--help', '-h']);

function isKnownFlag(a) {
  if (BARE_FLAGS.has(a) || HELP_FLAGS.has(a)) return true;
  return VALUE_FLAG_PREFIXES.some((p) => a.startsWith(p));
}

function parseArgs(argv, { onUnknown } = {}) {
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
    else if (a === '--baseline') args.baseline = DEFAULT_BASELINE_PATH();
    else if (a.startsWith('--baseline=')) args.baseline = a.slice('--baseline='.length);
    else if (a.startsWith('--show=')) args.show = a.split('=')[1];
    else if (a.startsWith('-') && !isKnownFlag(a)) unknown.push(a);
  }
  // A bare `--baseline` resolves through the injected repo path. If that
  // injection never happened, the old code would hand back `baseline: null`,
  // which reads downstream as "no baseline requested" — i.e. the gate silently
  // stops gating on the very flag CI passes to arm it. That is the same
  // silent-misconfiguration class as the --dry-run bug this file exists to fix,
  // so it fails loudly instead (GPT-4o review, 2026-09-01).
  if (argv.includes('--baseline') && !args.baseline) {
    const message =
      'Bare --baseline was passed but no default baseline path is configured. ' +
      'Call setDefaultBaselinePath() before parseArgs(), or pass --baseline=<path>. ' +
      'Refusing to run rather than silently gate on nothing (BRO-2705).';
    if (typeof onUnknown === 'function') return onUnknown(message, ['--baseline']);
    console.error(message);
    process.exit(2);
  }
  if (unknown.length) {
    const known = [...BARE_FLAGS, ...VALUE_FLAG_PREFIXES.map((p) => `${p}<value>`)].sort();
    const message =
      `Unrecognised flag(s): ${unknown.join(', ')}\n` +
      `Known flags: ${known.join(' ')}\n` +
      'Refusing to run: a silently-ignored flag on this script can turn an ' +
      'inspection into a corpus write (BRO-2705).';
    if (typeof onUnknown === 'function') return onUnknown(message, unknown);
    console.error(message);
    process.exit(2);
  }
  return args;
}

// Injected by the caller so this module does not need to know the repo layout;
// set once at require time by audit-self-contradictory-clears.js.
let _defaultBaselinePath = null;
function DEFAULT_BASELINE_PATH() {
  return _defaultBaselinePath;
}
function setDefaultBaselinePath(p) {
  _defaultBaselinePath = p;
}

module.exports = {
  parseArgs,
  setDefaultBaselinePath,
  isKnownFlag,
  BARE_FLAGS,
  VALUE_FLAG_PREFIXES,
};
