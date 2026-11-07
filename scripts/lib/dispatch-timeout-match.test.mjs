import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// CLAUDE.md rule 15: require() the REAL predicate the hook shells out to.
// Copying the regexes in here would make this test pass while the hook rots.
const { matchesTimeoutWrappedDispatch } = require('./dispatch-timeout-match.js');
const { stripFlag, spawnDetachedDispatch, waitForSettle, waitForSettleSync } = require('./spawn-detached-dispatch.js');

// ── the six commands that actually killed jobs on 2026-09-08 ──────────────
// Copied verbatim out of the v49 session transcript. Each SIGTERMed the
// supervisor; the predicted kill time matched the job log's last write to the
// second, 6/6.
const REAL_KILLS = [
  'timeout 300 node scripts/linear-next.js --id BRO-2565 --headless 2>&1 | tail -18',
  'timeout 110 node scripts/linear-next.js --id BRO-3052 --headless 2>&1 | tail -8',
  'timeout 110 node scripts/linear-next.js --id BRO-2664 --headless 2>&1 | tail -6',
  'timeout 110 node scripts/linear-next.js --id BRO-2664 --headless 2>&1 | tail -4',
  'timeout 110 node scripts/linear-next.js --id BRO-2495 --headless 2>&1 | tail -4',
  'timeout 110 node scripts/linear-next.js --id BRO-2425 --headless 2>&1 | tail -4',
];

const flags = (c) => matchesTimeoutWrappedDispatch(c).match;

test('flags every command that really killed a job on 2026-09-08', () => {
  for (const cmd of REAL_KILLS) {
    const r = matchesTimeoutWrappedDispatch(cmd);
    assert.equal(r.match, true, `should flag: ${cmd}`);
    assert.match(r.reason, /timeout wrapper/);
  }
});

test('flags the wrapper-prefix forms the other hooks already handle', () => {
  for (const cmd of [
    'timeout -k 5 30 node scripts/linear-next.js --id BRO-1 --headless',
    'timeout -s KILL 30 node scripts/linear-next.js --id BRO-1 --headless',
    'gtimeout 60 node scripts/bsc-next.js --id 123 --headless',
    'env FOO=1 timeout 60 node scripts/linear-next.js --id BRO-1 --headless',
    'nohup timeout 60 node scripts/linear-next.js --id BRO-1 --headless',
    'nice -n 10 timeout 60 node scripts/linear-next.js --id BRO-1 --headless',
  ]) {
    assert.equal(flags(cmd), true, `should flag: ${cmd}`);
  }
});

test('flags a dispatch that is not the first command in the line', () => {
  assert.equal(flags('cd /Users/tompryor/Broadwayscore && timeout 110 node scripts/linear-next.js --id BRO-9 --headless'), true);
});

test('flags an absolute-path invocation', () => {
  assert.equal(flags('timeout 90 node /Users/tompryor/Broadwayscore/scripts/linear-next.js --id BRO-9 --headless'), true);
});

// ── ship-check P0: the flag must be read the way the CLI reads it ─────────
test('flags --detach=0 even when the flag is NOT last (ship-check P0)', () => {
  // The lookahead used to anchor "is it off?" to end-of-STRING, so this read
  // as detached and was whitelisted — while coerceFlagValue (linear-next.js:206)
  // read it as OFF and ran the job attached, i.e. the exact 2026-09-08 kill.
  for (const cmd of [
    'timeout 110 node scripts/linear-next.js --id BRO-1 --detach=0 --headless 2>&1 | tail -8',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --detach=false --headless',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --detach= --headless',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless --detach=0',
  ]) {
    assert.equal(flags(cmd), true, `should flag: ${cmd}`);
  }
});

test('flags --DETACH: parseArgs is case-sensitive, so it does NOT detach (ship-check P0)', () => {
  assert.equal(flags('timeout 110 node scripts/linear-next.js --id BRO-1 --headless --DETACH'), true);
});

test('flags a dispatch hidden inside a quoted -c string (ship-check P1)', () => {
  for (const cmd of [
    `timeout 110 bash -lc 'node scripts/linear-next.js --id BRO-1 --headless'`,
    `timeout 110 sh -c "node scripts/linear-next.js --id BRO-1 --headless"`,
  ]) {
    assert.equal(flags(cmd), true, `should flag: ${cmd}`);
  }
});

// ── the allow side ────────────────────────────────────────────────────────
test('does NOT flag a detached dispatch — the wrapper cannot reach the job', () => {
  for (const cmd of [
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless --detach',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --detach --headless',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless --detach=1',
    'timeout 110 node scripts/bsc-next.js --id 42 --headless --detach',
  ]) {
    assert.equal(flags(cmd), false, `should NOT flag: ${cmd}`);
  }
});

test('does NOT flag --headless=0 / --headless=false — that is not the headless path', () => {
  for (const cmd of [
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless=0',
    'timeout 110 node scripts/linear-next.js --id BRO-1 --headless=false',
  ]) {
    assert.equal(flags(cmd), false, `should NOT flag: ${cmd}`);
  }
});

test('does NOT flag a backgrounded dispatch with an unrelated timeout after it (ship-check P2)', () => {
  // A single `&` starts a new command; `&&` does not.
  assert.equal(flags('node scripts/linear-next.js --id BRO-1 --headless & timeout 5 true'), false);
});

test('does NOT flag an unwrapped headless dispatch', () => {
  assert.equal(flags('node scripts/linear-next.js --id BRO-1 --headless'), false);
});

test('does NOT flag a timeout on an unrelated command in the same line', () => {
  assert.equal(flags('timeout 5 echo hi && node scripts/linear-next.js --id BRO-1 --headless'), false);
});

test('does NOT flag a cmux-tab (non-headless) dispatch, wrapped or not', () => {
  assert.equal(flags('timeout 110 node scripts/linear-next.js --id BRO-1'), false);
  assert.equal(flags('timeout 110 node scripts/linear-next.js --id BRO-1 --tab'), false);
  assert.equal(flags('timeout 60 node scripts/linear-next.js --list'), false);
});

test('does NOT flag unrelated commands', () => {
  for (const cmd of ['', 'ls -la', 'timeout 60 npm test', 'node scripts/bsc-prune.js']) {
    assert.equal(flags(cmd), false, `should NOT flag: ${cmd}`);
  }
});

// ── stripFlag: the re-exec must not loop ──────────────────────────────────
test('stripFlag removes exactly the spellings parseArgs accepts, so the re-exec cannot loop', () => {
  assert.deepEqual(stripFlag(['--id', 'BRO-1', '--headless', '--detach'], 'detach'), ['--id', 'BRO-1', '--headless']);
  assert.deepEqual(stripFlag(['--detach=1', '--id', 'BRO-1'], 'detach'), ['--id', 'BRO-1']);
  assert.deepEqual(stripFlag(['--detach=false', '--id', 'BRO-1'], 'detach'), ['--id', 'BRO-1']);
  // a flag whose NAME merely starts the same is untouched
  assert.deepEqual(stripFlag(['--detached-thing', '--id', 'BRO-1'], 'detach'), ['--detached-thing', '--id', 'BRO-1']);
});

// ── spawnDetachedDispatch ─────────────────────────────────────────────────
test('spawnDetachedDispatch always spawns detached, unref\'d, and in the given cwd', () => {
  let opts = null; let unrefd = false;
  const fake = (bin, argv, o) => { opts = { bin, argv, o }; return { pid: 4242, on() {}, unref() { unrefd = true; } }; };
  const r = spawnDetachedDispatch({
    scriptPath: '/tmp/does-not-need-to-exist/linear-next.js',
    argv: ['--id', 'BRO-1', '--headless'],
    logFile: '/tmp/claude-501/spawn-detached-dispatch.test.log',
    cwd: '/Users/tompryor/Broadwayscore',
    spawnFn: fake,
  });
  assert.equal(r.pid, 4242);
  assert.equal(opts.o.detached, true, 'detached:true is the entire point of this module');
  assert.equal(opts.o.stdio[0], 'ignore');
  assert.equal(opts.o.cwd, '/Users/tompryor/Broadwayscore', 'the child must run from the canonical repo, never a worktree');
  assert.equal(unrefd, true, 'unref() is what lets the launcher exit');
  assert.deepEqual(opts.argv.slice(1), ['--id', 'BRO-1', '--headless']);
});

test('spawnDetachedDispatch WARNS (never silently) when the log cannot be opened', () => {
  const warnings = [];
  const fake = () => ({ pid: 7, on() {}, unref() {} });
  spawnDetachedDispatch({
    scriptPath: '/tmp/x.js',
    argv: [],
    // a path under an existing FILE cannot be created as a directory
    logFile: '/etc/hosts/nope/child.log',
    spawnFn: fake,
    onError: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 1, 'a lost log must be reported, not swallowed');
  assert.match(warnings[0], /NO log/);
});

test('spawnDetachedDispatch refuses without a scriptPath or logFile', () => {
  assert.throws(() => spawnDetachedDispatch({ argv: [], logFile: '/tmp/x.log' }), /scriptPath and logFile/);
  assert.throws(() => spawnDetachedDispatch({ scriptPath: '/tmp/x.js', argv: [] }), /scriptPath and logFile/);
});

// ── waitForSettle: refusals must stay loud ────────────────────────────────
test('waitForSettle reports a child that exits inside the window as NOT alive', async () => {
  let calls = 0;
  const r = await waitForSettle(123, 1000, {
    pollMs: 100,
    isAlive: () => { calls += 1; return calls < 3; },
    sleep: async () => {},
  });
  assert.equal(r.alive, false, 'a fast exit is a refusal and must be surfaced');
  assert.equal(r.waitedMs, 200);
});

test('waitForSettle reports a child still running at the end of the window as alive', async () => {
  const r = await waitForSettle(123, 500, { pollMs: 100, isAlive: () => true, sleep: async () => {} });
  assert.equal(r.alive, true);
  assert.equal(r.waitedMs, 500);
});

test('waitForSettle with a zero/negative window skips the watch entirely', async () => {
  for (const w of [0, -1, NaN]) {
    const r = await waitForSettle(123, w, { isAlive: () => { throw new Error('must not poll'); } });
    assert.deepEqual(r, { alive: true, waitedMs: 0 });
  }
});

test('waitForSettleSync matches waitForSettle — bsc-next.js main() is not async', () => {
  let calls = 0;
  const dead = waitForSettleSync(123, 1000, {
    pollMs: 100, sleep: () => {}, isAlive: () => { calls += 1; return calls < 3; },
  });
  assert.deepEqual(dead, { alive: false, waitedMs: 200 });
  const live = waitForSettleSync(123, 500, { pollMs: 100, sleep: () => {}, isAlive: () => true });
  assert.deepEqual(live, { alive: true, waitedMs: 500 });
  assert.deepEqual(
    waitForSettleSync(123, 0, { isAlive: () => { throw new Error('must not poll'); } }),
    { alive: true, waitedMs: 0 },
  );
});
