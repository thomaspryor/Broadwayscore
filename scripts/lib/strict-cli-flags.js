'use strict';
// Strict CLI flag validation for destructive CLIs (BRO-8201). A typo like
// --dryrun must never silently fall through to a REAL deletion pass.
//   validateArgs(argv, { flags: ['--dry-run'], valueFlags: ['--root'] })
//     -> { help: bool, error: string|null }
// --help / -h always recognised. Anything not listed (incl. stray positionals
// that are not the value of a valueFlag) is an error.
function validateArgs(argv, { flags = [], valueFlags = [] } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [name] = a.split('=', 1);
    if (valueFlags.includes(name)) { if (!a.includes('=')) i++; continue; }
    if (flags.includes(a)) continue;
    return { help: false, error: `unrecognised argument: ${a}` };
  }
  return { help: false, error: null };
}

// Exits the process on --help (0) or bad args (2); returns otherwise.
function enforceArgs(argv, spec, usage) {
  const r = validateArgs(argv, spec);
  if (r.help) { console.log(usage); process.exit(0); }
  if (r.error) { console.error(`${r.error}\n${usage}`); process.exit(2); }
}

module.exports = { validateArgs, enforceArgs };
