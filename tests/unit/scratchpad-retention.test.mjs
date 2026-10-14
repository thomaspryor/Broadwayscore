import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { selectPrunable, pruneScratchpads, pruneScratchpadsIfDue } = require('../../scripts/lib/scratchpad-retention.js');

const H = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12);
const e = (name, ageH) => ({ dir: `/t/p/${name}`, name, newestMtimeMs: NOW - ageH * H });

test('selectPrunable: only old, non-live, non-current dirs', () => {
  const entries = [e('old-idle', 48), e('fresh', 1), e('old-live-by-id', 72), e('old-live-by-path', 72), e('current', 72)];
  const psText = 'claude --session-id old-live-by-id\nnode /t/p/old-live-by-path/scratchpad/x.js\n';
  const out = selectPrunable(entries, { now: NOW, psText, currentSessionId: 'current' }).map((x) => x.name);
  assert.deepEqual(out, ['old-idle']);
});

test('selectPrunable ignores malformed entries', () => {
  assert.deepEqual(selectPrunable([null, { dir: 'x' }, { dir: 'x', name: 'y', newestMtimeMs: NaN }], { now: NOW }), []);
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
    const idle = mk('idle', 48);
    const live = mk('live-session-id', 48);
    const active = mk('active', 48, 2); // dir mtime old, but a file inside is fresh
    const r = pruneScratchpads({ roots: [root], now: NOW, psText: 'claude --resume live-session-id', currentSessionId: '' });
    assert.deepEqual(r.deleted, [idle]);
    assert.ok(r.bytesFreed >= 5);
    assert.ok(fs.existsSync(live), 'live session dir survives although old');
    assert.ok(fs.existsSync(active), 'dir with fresh file inside survives');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pruneScratchpads: no liveness data (ps failed) deletes nothing', () => {
  const { root, mk } = tree();
  try {
    const idle = mk('idle', 48);
    const r = pruneScratchpads({ roots: [root], now: NOW, psText: null });
    assert.equal(r.deleted.length, 0);
    assert.ok(fs.existsSync(idle));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pruneScratchpads: missing root is a no-op', () => {
  const r = pruneScratchpads({ roots: ['/nonexistent-xyz'], now: NOW, psText: '' });
  assert.deepEqual(r.deleted, []);
});

test('pruneScratchpadsIfDue: second call inside cooldown does nothing', () => {
  const { root, mk } = tree();
  try {
    mk('idle', 48);
    const markerPath = path.join(root, 'marker.lock');
    const first = pruneScratchpadsIfDue({ markerPath, roots: [root], now: NOW, psText: '' });
    assert.equal(first.deleted.length, 1);
    mk('idle2', 48);
    assert.equal(pruneScratchpadsIfDue({ markerPath, roots: [root], now: NOW + 1000, psText: '' }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
