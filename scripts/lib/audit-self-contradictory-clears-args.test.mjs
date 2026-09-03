// BRO-2705 — `--dry-run` was silently ignored by
// audit-self-contradictory-clears.js, so `--fix-safe --dry-run` wrote the
// corpus. This repo treats the plain `--fix` on that script as UNTRUSTED (it
// excluded 438 live-scored reviews in August 2026), which makes `--dry-run` the
// designated way to inspect a remediation you distrust. The inspection was the
// mutation.
//
// These tests require() the REAL parser rather than restating its rules, per
// CLAUDE.md rule 15 — a copy here would keep passing while the script drifted.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, isKnownFlag } = require('./audit-self-contradictory-clears-args.js');

const BASELINE = '/repo/data/audit/self-contradictory-clears-baseline.json';

// onUnknown keeps the parser from calling process.exit() under the test runner;
// the production caller omits it and gets the exit-2 behaviour.
const capture = () => {
  const seen = [];
  const onUnknown = (message, offenders) => {
    seen.push({ message, offenders });
    return null;
  };
  return { seen, onUnknown };
};

test('--dry-run is recognised and sets dryRun (the BRO-2705 regression)', () => {
  const args = parseArgs(['--fix-safe', '--dry-run']);
  assert.equal(args.dryRun, true, '--dry-run must parse, not be silently dropped');
  assert.equal(args.fixSafe, true);
});

test('a bare --fix-safe does NOT set dryRun (the fix must not disarm remediation)', () => {
  const args = parseArgs(['--fix-safe']);
  assert.equal(args.dryRun, false);
  assert.equal(args.fixSafe, true);
});

test('--fix --dry-run parses both — the untrusted path is the one that most needs inspecting', () => {
  const args = parseArgs(['--fix', '--dry-run']);
  assert.equal(args.fix, true);
  assert.equal(args.dryRun, true);
});

test('an unrecognised flag is refused, not ignored (prevention for the whole class)', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--fix-safe', '--dryrun'], { onUnknown });
  assert.equal(seen.length, 1, 'a typo’d flag must be reported');
  assert.deepEqual(seen[0].offenders, ['--dryrun']);
  assert.match(seen[0].message, /Unrecognised argument/);
});

// The first version of this parser only rejected tokens starting with '-', so
// `--fix-safe dry-run` — a shell that ate the dashes, or a hand-typed flag
// missing them — was accepted silently and ran the REAL corpus write. That is
// the identical failure the flag exists to prevent, one token shape over.
test('a bare word is refused too: the script takes no positional arguments', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--fix-safe', 'dry-run'], { onUnknown });
  assert.equal(seen.length, 1, 'a dashless flag must not sail through into a corpus write');
  assert.deepEqual(seen[0].offenders, ['dry-run']);
  assert.match(seen[0].message, /no positional arguments/);
});

test('the error names the known flags so the operator can self-correct', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--no-such-flag'], { onUnknown });
  assert.match(seen[0].message, /--dry-run/);
  assert.match(seen[0].message, /--fix-safe/);
});

test('CI’s own invocation parses clean when given the baseline path', () => {
  const { seen, onUnknown } = capture();
  const args = parseArgs(['--gate', '--baseline'], { defaultBaselinePath: BASELINE, onUnknown });
  assert.equal(seen.length, 0, 'test.yml runs --gate --baseline; it must never be rejected');
  assert.equal(args.gate, true);
  assert.equal(args.baseline, BASELINE);
});

// The gate arms itself through a bare --baseline. If the path is ever not
// supplied, the old shape returned baseline:null, which downstream reads as "no
// baseline requested" — the gate silently stops gating. Same class as the
// --dry-run bug: a missing signal that looks like the safe outcome.
test('a bare --baseline with no configured path fails loudly, never silently ungates', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--gate', '--baseline'], { onUnknown });
  assert.equal(seen.length, 1, 'must refuse rather than hand back baseline:null');
  assert.match(seen[0].message, /no default baseline path/i);
});

// Passing the path per-call rather than through a module singleton means two
// consumers cannot clobber each other's configuration.
test('the baseline path is per-call, so calls cannot clobber each other', () => {
  const a = parseArgs(['--baseline'], { defaultBaselinePath: '/a.json' });
  const b = parseArgs(['--baseline'], { defaultBaselinePath: '/b.json' });
  assert.equal(a.baseline, '/a.json');
  assert.equal(b.baseline, '/b.json');
});

test('--baseline=<path> overrides without needing any injected default', () => {
  const { seen, onUnknown } = capture();
  const args = parseArgs(['--baseline=/tmp/b.json'], { onUnknown });
  assert.equal(seen.length, 0);
  assert.equal(args.baseline, '/tmp/b.json');
});

test('--show= is accepted by prefix, not rejected as unknown', () => {
  const { seen, onUnknown } = capture();
  const args = parseArgs(['--show=the-sound-of-music-2027'], { onUnknown });
  assert.equal(seen.length, 0);
  assert.equal(args.show, 'the-sound-of-music-2027');
});

test('--help and --help=1 both pass, matching cli-help.js hasHelpFlag', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--help'], { onUnknown });
  parseArgs(['--help=1'], { onUnknown });
  assert.equal(seen.length, 0);
  assert.equal(isKnownFlag('--help'), true);
  assert.equal(isKnownFlag('--help=1'), true);
});
