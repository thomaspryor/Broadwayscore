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
// real cmux sweep. main() here is a pure function of argv (no cmux calls
// happen before the help check), so calling it directly with a stubbed
// console proves the early return without touching cmuxAvailable/listWorkspaces.
test('--help / -h return before any cmux call', () => {
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    main(['--help']);
    main(['-h']);
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
