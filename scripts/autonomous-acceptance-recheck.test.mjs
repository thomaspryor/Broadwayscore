import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enforcementState, runVerify, parseArgs } = require('./autonomous-acceptance-recheck.js');

const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const rechecks = (n, firstTs) =>
  Array.from({ length: n }, (_, i) => ({ event: 'recheck', ts: i === 0 ? firstTs : ago(0) }));

test('enforcement is OFF by default — no config key, no enforcement', () => {
  assert.deepEqual(enforcementState({}, []), { enforcing: false, requested: false, reason: 'enforcement not requested (default)' });
  assert.equal(enforcementState(null, []).enforcing, false);
  assert.equal(enforcementState({ recheckEnforcement: false }, rechecks(50, ago(90))).enforcing, false);
});

// The point of the gate: setting the flag is a REQUEST, not a switch. Without
// the shadow record behind it, the answer is still no.
test('requesting enforcement without the shadow record does not enable it', () => {
  const s = enforcementState({ recheckEnforcement: true }, rechecks(3, ago(2)));
  assert.equal(s.requested, true);
  assert.equal(s.enforcing, false);
  assert.match(s.reason, /does not justify it yet/);
  assert.match(s.reason, /needs 7d \+ 10 rechecks \+ 0 false positives/);
});

test('enforcement enables only once days + volume + zero false positives all hold', () => {
  const s = enforcementState({ recheckEnforcement: true }, rechecks(12, ago(10)));
  assert.equal(s.enforcing, true);
  assert.match(s.reason, /clears the bar/);
});

test('one owner-recorded false positive blocks enforcement no matter the volume', () => {
  const entries = [...rechecks(50, ago(60)), { event: 'recheck-false-positive', ts: ago(1) }];
  assert.equal(enforcementState({ recheckEnforcement: true }, entries).enforcing, false);
});

test('runVerify refuses a command that fails safe-form re-validation at run time', () => {
  // Capture-time validation is not enough: the ledger is a local file that
  // could have been edited between dispatch and tonight.
  const r = runVerify(process.cwd(), 'node scripts/rebuild-all-reviews.js');
  assert.equal(r.status, 'unverifiable');
  assert.match(r.detail, /safe-form re-validation/);
});

test('runVerify runs a real safe command and reports pass', () => {
  // Path must sit under an allowed prefix (tests/, scripts/, src/, docs/,
  // memory/) — that is isSafeCheckCommand's rule, and this proves the real
  // validator is in the loop, not a stub.
  const r = runVerify(process.cwd(), 'test -f scripts/bsc-next.js');
  assert.equal(r.status, 'pass');
  assert.equal(runVerify(process.cwd(), 'test -f scripts/does-not-exist-xyz.js').status, 'fail');
});

test('parseArgs handles flags with and without values', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--limit', '3']), { 'dry-run': true, limit: '3' });
});

// Cousin bug class #260/#263/#264: --help must never fall through to the real
// run (which lists Notion cards and builds a git worktree).
test('node scripts/autonomous-acceptance-recheck.js --help prints usage and does nothing else', () => {
  const out = execFileSync('node', [new URL('./autonomous-acceptance-recheck.js', import.meta.url).pathname, '--help'],
    { encoding: 'utf8', timeout: 15_000 });
  assert.match(out, /Usage:/);
  assert.match(out, /shadow mode/i);
  assert.doesNotMatch(out, /card\(s\) marked Done/);
});
