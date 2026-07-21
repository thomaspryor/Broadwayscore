import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { main, USAGE } = require('./bsc-prune.js');

test('USAGE documents --dry-run and --help', () => {
  assert.match(USAGE, /--dry-run/);
  assert.match(USAGE, /--help, -h/);
});

// 2026-07-14 incident class: a bare --help must never fall through to the
// real cmux sweep. Every dep is stubbed to throw (not left as the real
// cmux-workspaces implementation) so this test actually PROVES zero cmux
// calls happen, instead of merely trusting the guard is still correctly
// placed — ship-check catch (2026-07-20): a test that calls real main() with
// real deps would itself perform a live prune if the guard were ever moved.
test('--help / -h return before any cmux call', () => {
  const throwingDeps = {
    cmuxAvailable: () => { throw new Error('cmuxAvailable must not be called for --help'); },
    listWorkspaces: () => { throw new Error('listWorkspaces must not be called for --help'); },
    pruneDone: () => { throw new Error('pruneDone must not be called for --help'); },
    isDoneTitle: () => { throw new Error('isDoneTitle must not be called for --help'); },
    claudeRunningIn: () => { throw new Error('claudeRunningIn must not be called for --help'); },
  };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.doesNotThrow(() => main(['--help'], throwingDeps));
    assert.doesNotThrow(() => main(['-h'], throwingDeps));
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /bsc-prune — close finished Cmux workspaces/);
  assert.match(logged[1], /bsc-prune — close finished Cmux workspaces/);
});

// Belt-and-suspenders: actually run the real CLI. If the --help guard were
// ever removed, this would fall through to `cmuxAvailable()`/`listWorkspaces()`
// (or, in bsc-conductor's case, an interactive `claude` launch) instead of
// exiting immediately — this test would then hang or print sweep output
// instead of usage.
test('node scripts/bsc-prune.js --help prints usage and exits 0 (real process)', () => {
  const out = execFileSync('node', [new URL('./bsc-prune.js', import.meta.url).pathname, '--help'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.match(out, /Usage:/);
  assert.match(out, /--dry-run/);
  assert.doesNotMatch(out, /cmux CLI not found/);
  assert.doesNotMatch(out, /Closed \d/);
});
