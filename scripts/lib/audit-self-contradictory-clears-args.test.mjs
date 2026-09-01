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

// onUnknown keeps the parser from calling process.exit() under the test runner;
// the production caller omits it and gets the exit-2 behaviour.
const capture = () => {
  const seen = [];
  const onUnknown = (message, unknown) => {
    seen.push({ message, unknown });
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
  assert.deepEqual(seen[0].unknown, ['--dryrun']);
  assert.match(seen[0].message, /Unrecognised flag/);
});

test('the error names the known flags so the operator can self-correct', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--no-such-flag'], { onUnknown });
  assert.match(seen[0].message, /--dry-run/);
  assert.match(seen[0].message, /--fix-safe/);
});

test('CI’s own invocation parses clean once the baseline path is injected', () => {
  const { setDefaultBaselinePath } = require('./audit-self-contradictory-clears-args.js');
  setDefaultBaselinePath('/repo/data/audit/self-contradictory-clears-baseline.json');
  const { seen, onUnknown } = capture();
  const args = parseArgs(['--gate', '--baseline'], { onUnknown });
  assert.equal(seen.length, 0, 'test.yml runs --gate --baseline; it must never be rejected');
  assert.equal(args.gate, true);
  assert.equal(args.baseline, '/repo/data/audit/self-contradictory-clears-baseline.json');
  setDefaultBaselinePath(null);
});

// The gate arms itself through a bare --baseline. If the path injection is ever
// missed, the old shape returned baseline:null, which downstream reads as "no
// baseline requested" — the gate silently stops gating. Same class as the
// --dry-run bug: a missing signal that looks like the safe outcome.
test('a bare --baseline with no configured path fails loudly, never silently ungates', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--gate', '--baseline'], { onUnknown });
  assert.equal(seen.length, 1, 'must refuse rather than hand back baseline:null');
  assert.match(seen[0].message, /no default baseline path/i);
});

test('value-bearing flags are accepted by prefix, not rejected as unknown', () => {
  const { seen, onUnknown } = capture();
  const args = parseArgs(['--show=the-sound-of-music-2027', '--baseline=/tmp/b.json'], { onUnknown });
  assert.equal(seen.length, 0);
  assert.equal(args.show, 'the-sound-of-music-2027');
  assert.equal(args.baseline, '/tmp/b.json');
});

test('--help is not treated as an unknown flag on its way past', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['--help'], { onUnknown });
  assert.equal(seen.length, 0);
  assert.equal(isKnownFlag('--help'), true);
});

test('a bare non-flag argument is not mistaken for a flag', () => {
  const { seen, onUnknown } = capture();
  parseArgs(['somefile.json'], { onUnknown });
  assert.equal(seen.length, 0);
});
