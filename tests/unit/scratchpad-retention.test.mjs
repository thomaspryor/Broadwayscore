import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const {
  selectPrunable, pruneScratchpads, pruneScratchpadsIfDue, readLiveSessionIds, formatPruneResult,
  DEFAULT_COOLDOWN_MS, DEFAULT_MARKER_PATH,
} = require('../../scripts/lib/scratchpad-retention.js');
const { MAIN_REPO_ROOT } = require('../../scripts/lib/repo-root');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const H = 3600 * 1000;
// Real clock: pruneDue stamps its marker with the real mtime, so a fixed past
// NOW made the cooldown test pass for any cooldown (BRO-5261 retro-review).
const NOW = Date.now();
// Session dirs are named by session UUID; anything else is never a candidate.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDLE = uuid(1), FRESH = uuid(2), LIVE_PS = uuid(3), LIVE_PATH = uuid(4), CURRENT = uuid(5), LIVE_REG = uuid(6), ACTIVE = uuid(7), IDLE2 = uuid(8);
const e = (name, ageH) => ({ dir: `/t/p/${name}`, name, newestMtimeMs: NOW - ageH * H });

test('selectPrunable: only old, non-live, non-current session dirs', () => {
  const entries = [e(IDLE, 48), e(FRESH, 1), e(LIVE_PS, 72), e(LIVE_PATH, 72), e(CURRENT, 72), e(LIVE_REG, 72)];
  const psText = `claude --resume ${LIVE_PS}\nnode /t/p/${LIVE_PATH}/scratchpad/x.js\n`;
  const out = selectPrunable(entries, { now: NOW, psText, currentSessionId: CURRENT, liveIds: new Set([LIVE_REG]) }).map((x) => x.name);
  assert.deepEqual(out, [IDLE]);
});

test('selectPrunable never selects a non-session dir (harness bash-edit-diff/<hash>)', () => {
  const out = selectPrunable([e('9563740228897704616-4907500416148182975-b4f828e5085f6e72', 500), e('cache', 500)], { now: NOW });
  assert.deepEqual(out, []);
});

test('selectPrunable ignores malformed entries', () => {
  assert.deepEqual(selectPrunable([null, { dir: 'x' }, { dir: 'x', name: IDLE, newestMtimeMs: NaN }], { now: NOW }), []);
});

test('readLiveSessionIds: live pid rows only, *.json only, unreadable dir => null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessreg-'));
  try {
    fs.writeFileSync(path.join(dir, '11.json'), JSON.stringify({ pid: 11, sessionId: LIVE_REG.toUpperCase() }));
    fs.writeFileSync(path.join(dir, '12.json'), JSON.stringify({ pid: 12, sessionId: IDLE }));
    fs.writeFileSync(path.join(dir, '13.json'), '{torn');
    fs.writeFileSync(path.join(dir, '11.abc.key'), 'x');
    const ids = readLiveSessionIds({ registryDir: dir, isAlive: (pid) => pid === 11 });
    assert.deepEqual([...ids], [LIVE_REG]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(readLiveSessionIds({ registryDir: '/nonexistent-registry-xyz' }), null);
});

test('readLiveSessionIds sees this very process as live through the real pid check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessreg-'));
  try {
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: LIVE_REG }));
    assert.ok(readLiveSessionIds({ registryDir: dir }).has(LIVE_REG));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-'));
  const mk = (name, ageH, innerAgeH = ageH) => {
    const d = path.join(root, 'proj', name);
    fs.mkdirSync(path.join(d, 'scratchpad'), { recursive: true });
    const f = path.join(d, 'scratchpad', 'a.txt');
    fs.writeFileSync(f, 'hello');
    const t = (NOW - innerAgeH * H) / 1000;
    fs.utimesSync(f, t, t);
    fs.utimesSync(path.join(d, 'scratchpad'), t, t);
    fs.utimesSync(d, (NOW - ageH * H) / 1000, (NOW - ageH * H) / 1000);
    return d;
  };
  return { root, mk };
}

test('pruneScratchpads: deletes idle old dir, never a live or recently-active one', () => {
  const { root, mk } = tree();
  try {
    const idle = mk(IDLE, 48);
    const livePs = mk(LIVE_PS, 48);
    const liveReg = mk(LIVE_REG, 48);
    const active = mk(ACTIVE, 48, 2); // dir mtime old, but a file inside is fresh
    const harness = mk('9563740228897704616-4907500416148182975-b4f828e5085f6e72', 500);
    const r = pruneScratchpads({ roots: [root], now: NOW, psText: `claude --resume ${LIVE_PS}`, liveIds: new Set([LIVE_REG]), currentSessionId: '' });
    assert.deepEqual(r.deleted, [idle]);
    assert.ok(r.bytesFreed >= 5);
    assert.ok(fs.existsSync(livePs), 'session named on a live command line survives');
    assert.ok(fs.existsSync(liveReg), 'session with a live registry row survives although old and absent from ps');
    assert.ok(fs.existsSync(active), 'dir with fresh file inside survives');
    assert.ok(fs.existsSync(harness), 'non-session harness dir survives');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pruneScratchpads: no liveness data (ps failed or registry unreadable) deletes nothing', () => {
  const { root, mk } = tree();
  try {
    const idle = mk(IDLE, 48);
    for (const opts of [{ psText: null, liveIds: new Set() }, { psText: '', liveIds: null }]) {
      const r = pruneScratchpads({ roots: [root], now: NOW, ...opts });
      assert.equal(r.deleted.length, 0);
      assert.equal(r.errors.length, 1);
      assert.match(formatPruneResult(r), /SCRATCHPAD RETENTION: 1 issue/);
    }
    assert.ok(fs.existsSync(idle));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pruneScratchpads: missing root is a no-op', () => {
  const r = pruneScratchpads({ roots: ['/nonexistent-xyz'], now: NOW, psText: '', liveIds: new Set() });
  assert.deepEqual(r.deleted, []);
  assert.equal(formatPruneResult(r), '');
});

test('pruneScratchpadsIfDue: inside cooldown does nothing, after it prunes again', () => {
  const { root, mk } = tree();
  try {
    mk(IDLE, 48);
    const markerPath = path.join(root, 'marker.lock');
    const opts = { markerPath, roots: [root], psText: '', liveIds: new Set() };
    const first = pruneScratchpadsIfDue({ ...opts, now: NOW });
    assert.equal(first.deleted.length, 1);
    // Pin the marker mtime to the test's NOW: fs mtimes are not clock-shifted, so
    // the real stamp would diverge from a shifted Date.now() (BRO-5410 time-bomb).
    fs.utimesSync(markerPath, NOW / 1000, NOW / 1000);
    mk(IDLE2, 48);
    assert.equal(pruneScratchpadsIfDue({ ...opts, now: NOW + 1000 }), null);
    const later = pruneScratchpadsIfDue({ ...opts, now: NOW + DEFAULT_COOLDOWN_MS + 60_000 });
    assert.ok(later, 'cooldown elapsed: the claim is won again');
    assert.equal(later.deleted.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cooldown marker lives under the main repo root (one per machine, not per worktree)', () => {
  assert.equal(DEFAULT_MARKER_PATH, path.join(MAIN_REPO_ROOT, 'data', 'audit', 'scratchpad-prune.lock'));
});

test('session-start.sh runs the scratchpad prune and prints its result', () => {
  const hook = fs.readFileSync(path.join(ROOT, '.claude', 'hooks', 'session-start.sh'), 'utf8');
  const line = hook.split('\n').find((l) => l.includes('BRO-2572'));
  assert.ok(line, 'hook names the scratchpad prune');
  assert.match(line, /"scratchpad-retention\.js"/);
  assert.match(line, /formatPruneResult\(s\.pruneScratchpadsIfDue\(\{\}\)\)/);
  // The node -e body is single-quoted in bash: a single quote would end it.
  assert.doesNotMatch(line, /'/);
  // Run that exact line's require path the way the hook resolves it.
  const lib = path.join(ROOT, 'scripts', 'lib', 'job-log-retention.js');
  const out = execFileSync(process.execPath, ['-e', 'const s = require(require("path").join(require("path").dirname(process.argv[1]), "scratchpad-retention.js")); console.log(typeof s.pruneScratchpadsIfDue, typeof s.formatPruneResult)', lib], { encoding: 'utf8' });
  assert.equal(out.trim(), 'function function');
});
