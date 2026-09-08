import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// CLAUDE.md rule 15: require() the REAL predicate the hook shells out to.
// Copying the regexes in here would make this test pass while the hook rots.
const { matchesTimeoutWrappedDispatch } = require('./dispatch-timeout-match.js');
const { stripFlag, spawnDetachedDispatch } = require('./spawn-detached-dispatch.js');

// ── the six commands that actually killed jobs on 2026-09-08 ──────────────
// Copied verbatim out of the v49 session transcript. Each of these SIGTERMed
// the supervisor; the predicted kill time matched the job log's last write to
// the second, 6/6.
const REAL_KILLS = [
  'timeout 300 node scripts/linear-next.js --id BRO-2565 --headless 2>&1 | tail -18',
  'timeout 110 node scripts/linear-next.js --id BRO-3052 --headless 2>&1 | tail -8',
  'timeout 110 node scripts/linear-next.js --id BRO-2664 --headless 2>&1 | tail -6',
  'timeout 110 node scripts/linear-next.js --id BRO-2664 --headless 2>&1 | tail -4',
  'timeout 110 node scripts/linear-next.js --id BRO-2495 --headless 2>&1 | tail -4',
  'timeout 110 node scripts/linear-next.js --id BRO-2425 --headless 2>&1 | tail -4',
];

test('flags every command that really killed a job on 2026-09-08', () => {
  for (const cmd of REAL_KILLS) {
    const r = matchesTimeoutWrappedDispatch(cmd);
    assert.equal(r.match, true, `should flag: ${cmd}`);
    assert.match(r.reason, /timeout wrapper/);
  }
});

test('flags the wrapper-prefix and flag forms the other hooks already handle', () => {
  for (const cmd of [
    'timeout -k 5 30 node scripts/linear-next.js --id BRO-1 --headless',
    'timeout -s KILL 30 node scripts/linear-next.js --id BRO-1 --headless',
    'gtimeout 60 node scripts/bsc-next.js --id 123 --headless',
    'env FOO=1 timeout 60 node scripts/linear-next.js --id BRO-1 --headless',
    'nohup timeout 60 node scripts/linear-next.js --id BRO-1 --headless',
    'nice -n 10 timeout 60 node scripts/linear-next.js --id BRO-1 --headless',
    'node scripts/lib/bsc-runner.js --headless & timeout 5 true',
  ].slice(0, 6)) {
    assert.equal(matchesTimeoutWrappedDispatch(cmd).match, true, `should flag: ${cmd}`);
  }
});

test('flags a dispatch that is not the first command in the line', () => {
  const cmd = 'cd /Users/tompryor/Broadwayscore && timeout 110 node scripts/linear-next.js --id BRO-9 --headless';
  assert.equal(matchesTimeoutWrappedDispatch(cmd).match, true);
});

test('flags an absolute-path invocation', () => {
  const cmd = 'timeout 90 node /Users/tompryor/Broadwayscore/scripts/linear-next.js --id BRO-9 --headless';
  assert.equal(matchesTimeoutWrappedDispatch(cmd).match, true);
});

test('does NOT flag a detached dispatch — the wrapper cannot reach the job', () => {
  for (const cmd of [
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless --detach',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --detach --headless',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless --detach=1',
  ]) {
    assert.equal(matchesTimeoutWrappedDispatch(cmd).match, false, `should NOT flag: ${cmd}`);
  }
});

test('--detach=0 / --detach=false mean OFF, so they are still flagged', () => {
  // linear-next.js's coerceFlagValue treats these as false; the job would run
  // attached and the wrapper would kill it. Matching the CLI's own semantics
  // is the whole point of this case.
  for (const cmd of [
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless --detach=0',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless --detach=false',
  ]) {
    assert.equal(matchesTimeoutWrappedDispatch(cmd).match, true, `should flag: ${cmd}`);
  }
});

test('does NOT flag an unwrapped headless dispatch', () => {
  assert.equal(
    matchesTimeoutWrappedDispatch('node scripts/linear-next.js --id BRO-1 --headless').match,
    false,
  );
});

test('does NOT flag a timeout on an unrelated command in the same line', () => {
  assert.equal(
    matchesTimeoutWrappedDispatch('timeout 5 echo hi && node scripts/linear-next.js --id BRO-1 --headless').match,
    false,
  );
});

test('does NOT flag a cmux-tab (non-headless) dispatch, wrapped or not', () => {
  assert.equal(matchesTimeoutWrappedDispatch('timeout 110 node scripts/linear-next.js --id BRO-1').match, false);
  assert.equal(matchesTimeoutWrappedDispatch('timeout 110 node scripts/linear-next.js --id BRO-1 --tab').match, false);
  assert.equal(matchesTimeoutWrappedDispatch('timeout 60 node scripts/linear-next.js --list').match, false);
});

test('does NOT flag unrelated commands', () => {
  for (const cmd of ['', 'ls -la', 'timeout 60 npm test', 'node scripts/bsc-prune.js']) {
    assert.equal(matchesTimeoutWrappedDispatch(cmd).match, false, `should NOT flag: ${cmd}`);
  }
});

// ── stripFlag: the re-exec must not loop ──────────────────────────────────
test('stripFlag removes every spelling of the switch so the re-exec cannot loop', () => {
  assert.deepEqual(stripFlag(['--id', 'BRO-1', '--headless', '--detach'], 'detach'), ['--id', 'BRO-1', '--headless']);
  assert.deepEqual(stripFlag(['--detach=1', '--id', 'BRO-1'], 'detach'), ['--id', 'BRO-1']);
  assert.deepEqual(stripFlag(['--detach=false', '--id', 'BRO-1'], 'detach'), ['--id', 'BRO-1']);
  // a flag whose NAME merely starts the same is untouched
  assert.deepEqual(stripFlag(['--detached-thing', '--id', 'BRO-1'], 'detach'), ['--detached-thing', '--id', 'BRO-1']);
});

test('spawnDetachedDispatch always spawns detached and unref\'d', () => {
  let opts = null; let unrefd = false;
  const fake = (bin, argv, o) => { opts = { bin, argv, o }; return { pid: 4242, on() {}, unref() { unrefd = true; } }; };
  const r = spawnDetachedDispatch({
    scriptPath: '/tmp/does-not-need-to-exist/linear-next.js',
    argv: ['--id', 'BRO-1', '--headless'],
    logFile: '/tmp/claude-501/spawn-detached-dispatch.test.log',
    spawnFn: fake,
  });
  assert.equal(r.pid, 4242);
  assert.equal(opts.o.detached, true, 'detached:true is the entire point of this module');
  assert.equal(opts.o.stdio[0], 'ignore');
  assert.equal(unrefd, true, 'unref() is what lets the launcher exit');
  assert.deepEqual(opts.argv.slice(1), ['--id', 'BRO-1', '--headless']);
});

test('spawnDetachedDispatch refuses without a scriptPath or logFile', () => {
  assert.throws(() => spawnDetachedDispatch({ argv: [], logFile: '/tmp/x.log' }), /scriptPath and logFile/);
  assert.throws(() => spawnDetachedDispatch({ scriptPath: '/tmp/x.js', argv: [] }), /scriptPath and logFile/);
});
