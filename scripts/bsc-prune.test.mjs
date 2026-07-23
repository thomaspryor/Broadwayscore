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
    claudeAliveIn: () => { throw new Error('claudeAliveIn must not be called for --help'); },
    readLedgerEntries: () => { throw new Error('readLedgerEntries must not be called for --help'); },
    appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for --help'); },
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

// Task #334: an idle-unmarked workspace that a launch record attributes to a
// task gets (a) labeled in the console report and (b) a 'dead' breadcrumb
// appended to the dispatch ledger — even under --dry-run, since the
// breadcrumb write never touches cmux state (only bsc-conductor's habitual
// `bsc-prune --dry-run` sweep runs this unattended, so dry-run must still
// record it).
test('idle workspace matching a ledger launch: labeled in output + dead breadcrumb appended (incl. under --dry-run)', () => {
  const idleWs = { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' };
  const unrelatedWs = { ref: 'workspace:900', title: 'Some manually opened tab' };
  const appended = [];
  const deps = {
    cmuxAvailable: () => true,
    listWorkspaces: () => [idleWs, unrelatedWs],
    pruneDone: () => ({ closed: [], skipped: [] }),
    isDoneTitle: () => false,
    claudeAliveIn: () => false, // both idle
    readLedgerEntries: () => [
      { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
    ],
    appendLedgerEntry: (e) => appended.push(e),
  };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    main(['--dry-run'], deps);
  } finally {
    console.log = origLog;
  }
  const out = logged.join('\n');
  assert.match(out, /workspace:227.*died mid task #297 "T1-retrieval Sprint 2"/);
  assert.doesNotMatch(out, /workspace:900.*died mid task/);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], { event: 'dead', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227', title: 'T1-retrieval Sprint 2' });
  assert.match(out, /Recorded 1 new dead-dispatch breadcrumb/);
});

test('idle workspace already recorded dead in the ledger: no duplicate breadcrumb', () => {
  const idleWs = { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' };
  const appended = [];
  const deps = {
    cmuxAvailable: () => true,
    listWorkspaces: () => [idleWs],
    pruneDone: () => ({ closed: [], skipped: [] }),
    isDoneTitle: () => false,
    claudeAliveIn: () => false,
    readLedgerEntries: () => [
      { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
      { event: 'dead', taskId: '297', workspaceRef: 'workspace:227' },
    ],
    appendLedgerEntry: (e) => appended.push(e),
  };
  const origLog = console.log;
  console.log = () => {};
  try { main([], deps); } finally { console.log = origLog; }
  assert.equal(appended.length, 0);
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
