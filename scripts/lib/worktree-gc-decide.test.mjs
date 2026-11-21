// BRO-2694 — the worktree GC reclaimed nothing (freed=0KB) because ANY
// process with its cwd inside a merged worktree kept it forever. These tests
// drive the real decision functions (CLAUDE.md §15: require, never copy):
//  - a MERGED worktree pinned only by a process that is NOT a live claude
//    session (an orphaned, idle tree rooted in the worktree) is reclaimable;
//  - a MERGED worktree pinned by a LIVE claude session is still kept;
//  - every ambiguous shape (terminal, editor, young orphan, inconsistent
//    snapshot, garbage input) keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  decideWorktreeReclaim, classifyCwdPin, cwdPinBlocks, parsePsTable, parseLsofCwds,
  parseEtime, parseMinAgeHours,
} = require('./worktree-gc-reclaim.js');
const { decideFromArgv } = require('./worktree-gc-decide.js');
const { cwdPinStatus } = require('./gc-worktree-liveness.js');

const DECIDE_CLI = fileURLToPath(new URL('./worktree-gc-decide.js', import.meta.url));
const LIVENESS_CLI = fileURLToPath(new URL('./gc-worktree-liveness.js', import.meta.url));

const WT = '/repo/.claude/worktrees/bro-1-done';
const DAY = 86400;
const merged = { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false };

// ---- decideWorktreeReclaim: the acceptance pair ---------------------------

test('ACCEPTANCE: merged worktree pinned by a process that is not a live claude session is reclaimable', () => {
  const r = decideWorktreeReclaim({ ...merged, cwdPin: 'stale-process', worktreeIdle: true });
  assert.equal(r.removable, true);
  assert.equal(r.blocker, null);
  assert.match(r.reason, /orphaned/);
});

test('ACCEPTANCE: merged worktree pinned by a LIVE claude session is kept', () => {
  const r = decideWorktreeReclaim({ ...merged, cwdPin: 'live-session', worktreeIdle: true });
  assert.equal(r.removable, false);
  assert.equal(r.blocker, 'cwd-pin');
  assert.match(r.reason, /live process/);
});

test('decide: stale-process pin on a recently touched worktree is kept', () => {
  const r = decideWorktreeReclaim({ ...merged, cwdPin: 'stale-process', worktreeIdle: false });
  assert.deepEqual([r.removable, r.blocker], [false, 'cwd-pin']);
});

test('decide: foreign, unknown and unrecognised pins keep; no pin removes', () => {
  for (const cwdPin of ['foreign-process', 'unknown', 'bogus', '']) {
    const r = decideWorktreeReclaim({ ...merged, cwdPin, worktreeIdle: true });
    assert.deepEqual([r.removable, r.blocker], [false, 'cwd-pin'], cwdPin);
  }
  assert.equal(decideWorktreeReclaim({ ...merged }).removable, true, 'default cwdPin is none (gc-worktree.js caller)');
  assert.equal(decideWorktreeReclaim({ isAncestorOfMain: false, hasUnmergedCommits: false, hasLiveLease: false, cwdPin: 'none' }).removable, true);
});

test('decide: unmerged and live-lease still win over any pin class', () => {
  const u = decideWorktreeReclaim({ isAncestorOfMain: false, hasUnmergedCommits: true, hasLiveLease: false, cwdPin: 'stale-process', worktreeIdle: true });
  assert.deepEqual([u.removable, u.blocker], [false, 'unmerged']);
  const l = decideWorktreeReclaim({ ...merged, hasLiveLease: true, cwdPin: 'stale-process', worktreeIdle: true });
  assert.deepEqual([l.removable, l.blocker], [false, 'lease']);
});

test('cwdPinBlocks: only none and stale-process can ever allow removal', () => {
  assert.equal(cwdPinBlocks('none'), false);
  assert.equal(cwdPinBlocks('stale-process'), false);
  for (const p of ['live-session', 'foreign-process', 'unknown', 'x']) assert.equal(cwdPinBlocks(p), true, p);
});

// ---- CLI exit-code contract (what gc-merged-worktrees.sh reads) -----------

test('decideFromArgv: 0 removable, 3 cwd-pin, 1 unmerged; garbage pin reads as unknown', () => {
  const base = ['--is-ancestor=1', '--has-unmerged=0', '--has-live-lease=0'];
  assert.equal(decideFromArgv([...base, '--cwd-pin=stale-process', '--worktree-idle=1']).exitCode, 0);
  assert.equal(decideFromArgv([...base, '--cwd-pin=live-session', '--worktree-idle=1']).exitCode, 3);
  assert.equal(decideFromArgv([...base, '--cwd-pin=stale-process', '--worktree-idle=0']).exitCode, 3);
  assert.equal(decideFromArgv([...base, '--cwd-pin=nonsense', '--worktree-idle=1']).exitCode, 3);
  assert.equal(decideFromArgv(base).exitCode, 0, 'absent --cwd-pin keeps the pre-BRO-2694 contract');
  assert.equal(decideFromArgv(['--is-ancestor=0', '--has-unmerged=1', '--has-live-lease=0', '--cwd-pin=stale-process']).exitCode, 1);
});

test('decide CLI process exits 3 for a live-session pin and 0 for an idle stale pin', () => {
  const run = (pin) => spawnSync(process.execPath, [DECIDE_CLI, '--is-ancestor=1', '--has-unmerged=0', '--has-live-lease=0', `--cwd-pin=${pin}`, '--worktree-idle=1']).status;
  assert.equal(run('live-session'), 3);
  assert.equal(run('stale-process'), 0);
});

// ---- classifyCwdPin over synthetic snapshots --------------------------------

function snap(rows) {
  // rows: [pid, ppid, etimeSec, tty, command, cwd]
  const procs = new Map();
  const cwds = new Map();
  for (const [pid, ppid, etimeSec, tty, command, cwd] of rows) {
    procs.set(pid, { ppid, etimeSec, tty, command });
    if (cwd) cwds.set(pid, cwd);
  }
  return { procs, cwds };
}
const classify = (rows, extra = {}) => classifyCwdPin({ worktreePath: WT, ...snap(rows), ...extra }).pin;

test('classify: no pinner -> none', () => {
  assert.equal(classify([[50, 1, 9 * DAY, '?', 'node server.js', '/elsewhere']]), 'none');
});

test('classify: orphaned old dev server tree rooted in the worktree -> stale-process', () => {
  assert.equal(classify([
    [100, 1, 5 * DAY, '??', 'node /x/next start', WT],
    [101, 100, 5 * DAY, '??', 'node /x/next-worker.js', `${WT}/web`],
  ]), 'stale-process');
});

test('classify: a claude session as the pinner, or as an ancestor of it -> live-session', () => {
  assert.equal(classify([[200, 1, 3 * DAY, '?', '/Users/u/.local/bin/claude --session-id abc', WT]]), 'live-session');
  // claude itself sits in the main checkout; its tool shell cds into the worktree.
  assert.equal(classify([
    [300, 1, 3 * DAY, '?', '/opt/claude-code/bin/claude --output-format=stream-json', '/repo'],
    [301, 300, 2 * DAY, '?', 'bash -c npm run dev', WT],
  ]), 'live-session');
  for (const cmd of ['/Users/u/.local/share/claude/versions/2.1.0 -p x', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'claude']) {
    assert.equal(classify([[400, 1, 3 * DAY, '?', cmd, WT]]), 'live-session', cmd);
  }
});

test('classify: a terminal anywhere on the chain -> live-session', () => {
  assert.equal(classify([
    [500, 1, 9 * DAY, 'ttys003', '-zsh', WT],
    [501, 500, 9 * DAY, '??', 'node server.js', WT],
  ]), 'live-session');
});

test('classify: orphaned tree younger than the age gate -> live-session; 0h gate allows it', () => {
  const rows = [[600, 1, 3600, '?', 'node server.js', WT]];
  assert.equal(classify(rows), 'live-session');
  assert.equal(classify(rows, { minAgeHours: 0 }), 'stale-process');
  assert.equal(classify(rows, { minAgeHours: -5 }), 'live-session', 'negative gate falls back to 24h, never off');
});

test('classify: tree rooted outside the worktree (editor, subreaper) -> foreign-process', () => {
  assert.equal(classify([
    [700, 1, 9 * DAY, '??', '/Applications/Code.app/Contents/MacOS/Electron', '/'],
    [701, 700, 9 * DAY, '??', 'node tsserver.js', WT],
  ]), 'foreign-process');
});

test('classify: inconsistent snapshots -> unknown', () => {
  assert.equal(classify([[800, 799, 9 * DAY, '?', 'node a', WT]]), 'unknown', 'parent missing from ps');
  assert.equal(classifyCwdPin({ worktreePath: WT, cwds: new Map([[900, WT]]), procs: new Map() }).pin, 'unknown', 'pinner missing from ps');
  assert.equal(classify([[810, 811, 9 * DAY, '?', 'a', WT], [811, 810, 9 * DAY, '?', 'b', '/x']]), 'unknown', 'cycle');
  assert.equal(classify([[820, 1, null, '?', 'node a', WT]]), 'unknown', 'unparseable age');
  assert.equal(classify([[830, 0, 9 * DAY, '?', 'init', WT]]), 'unknown', 'chain ends at ppid 0');
  assert.equal(classify([[840, 841, 9 * DAY, '?', 'a', WT], [841, 1, 9 * DAY, '?', 'b', null]]), 'unknown', 'root cwd unseen by lsof');
});

test('classify: the most protective class wins across pinners', () => {
  assert.equal(classify([
    [100, 1, 5 * DAY, '?', 'node next start', WT],
    [200, 1, 3 * DAY, '?', 'claude --session-id s', WT],
  ]), 'live-session');
});

test('classify: a sibling path sharing the prefix is not a pin', () => {
  assert.equal(classify([[100, 1, 5 * DAY, '?', 'node a', `${WT}-other`]]), 'none');
});

// ---- parsers ----------------------------------------------------------------

test('parseEtime handles ps etime forms and rejects garbage', () => {
  assert.equal(parseEtime('05:09'), 309);
  assert.equal(parseEtime('02:05:09'), 7509);
  assert.equal(parseEtime('3-02:05:09'), 3 * DAY + 7509);
  assert.equal(parseEtime('abc'), null);
  assert.equal(parseMinAgeHours(''), 24);
  assert.equal(parseMinAgeHours('2'), 2);
  assert.equal(parseMinAgeHours('-1'), 24);
});

test('parsePsTable / parseLsofCwds read linux and macOS shapes', () => {
  const t = parsePsTable('  101     1 3-01:00:00 ??       /usr/bin/node /x/next start\n 7 1 00:05 ttys001 -zsh\n');
  assert.deepEqual(t.get(101), { ppid: 1, etimeSec: 3 * DAY + 3600, tty: '??', command: '/usr/bin/node /x/next start' });
  assert.equal(t.get(7).tty, 'ttys001');
  const c = parseLsofCwds('p12\nfcwd\nn/a/b\np13\nfcwd\nn/c d\n');
  assert.deepEqual([...c], [[12, '/a/b'], [13, '/c d']]);
});

// ---- real processes through the real I/O path -------------------------------

const { LSOF } = require('./system-bin.js');
const hasLsof = spawnSync(LSOF, ['-v']).error === undefined;

function waitMs(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

test('real orphan rooted in a merged worktree classifies stale-process; a claude-named parent keeps it live-session', { skip: !hasLsof && 'lsof unavailable' }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2694-'));
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt);
  const pids = [];
  t.after(() => {
    for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Orphan: sh backgrounds node and exits, so node is reparented to init.
  const orphanPid = Number(execFileSync('sh', ['-c', 'node -e "setInterval(()=>{},1000)" >/dev/null 2>&1 & echo $!'], { cwd: wt, encoding: 'utf8' }).trim());
  pids.push(orphanPid);
  waitMs(400);
  const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(orphanPid)], { encoding: 'utf8' }).trim());
  if (ppid !== 1) { t.skip(`orphan adopted by subreaper ${ppid}, not init`); return; }

  assert.equal(cwdPinStatus(wt, { minAgeHours: 0 }).pin, 'stale-process');
  assert.equal(cwdPinStatus(wt, { minAgeHours: 24 }).pin, 'live-session', 'a minutes-old orphan is not stale yet');
  const cli = spawnSync(process.execPath, [LIVENESS_CLI, `--path=${wt}`, '--classify'], { env: { ...process.env, WORKTREE_GC_PIN_MIN_AGE_HOURS: '0' }, encoding: 'utf8' });
  assert.equal(cli.stdout.split('\n')[0], 'stale-process');
  assert.equal(cli.status, 1, 'stale-process alone does not block');

  // Live session: a process named `claude` whose child pins the worktree.
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const fakeClaude = path.join(binDir, 'claude');
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nnode -e "setInterval(()=>{},1000)" &\nwait\n', { mode: 0o755 });
  const sess = spawn(fakeClaude, [], { cwd: wt, stdio: 'ignore', detached: true });
  pids.push(-sess.pid, sess.pid);
  waitMs(400);
  assert.equal(cwdPinStatus(wt, { minAgeHours: 0 }).pin, 'live-session');
});
