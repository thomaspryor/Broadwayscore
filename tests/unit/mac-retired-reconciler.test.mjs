// BRO-5085: launchctl reconciler driven by config/mac-retired.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const rec = require(path.join(ROOT, 'scripts/lib/mac-retired-reconciler.js'));
const hb = require(path.join(ROOT, 'scripts/lib/mac-applied-heartbeat.js'));

const LIST = [
  'PID\tStatus\tLabel',
  '-\t0\tcom.bwsc.opening-night-monitor',
  '123\t0\tcom.broadwayscore.checkout-sync',
  '-\t0\tcom.broadwayscore.cookie-renew',
  '-\t0\tcom.apple.something',
].join('\n');

const entry = (label, extra = {}) => ({ label, retiredAt: '2026-10-01', replacedBy: ['x'], watchers: [{ conditionKey: 'k', file: 'f' }], ...extra });
const NOW = new Date('2026-10-20T12:00:00Z');

test('parses launchctl list labels, skipping the header', () => {
  const s = rec.parseLaunchctlList(LIST);
  assert.ok(s.has('com.bwsc.opening-night-monitor'));
  assert.ok(s.has('com.broadwayscore.checkout-sync'));
  assert.ok(!s.has('Label'));
});

test('boots out only loaded retired labels, and moves present plists', () => {
  const config = { entries: [entry('com.bwsc.opening-night-monitor'), entry('com.bwsc.not-loaded')] };
  const plan = rec.planReconcile({ config, loaded: LIST, presentPlists: new Set(['com.bwsc.opening-night-monitor']), now: NOW });
  assert.deepEqual(plan.actions, [
    { type: 'move-plist', label: 'com.bwsc.opening-night-monitor' },
    { type: 'bootout', label: 'com.bwsc.opening-night-monitor' },
  ]);
  assert.deepEqual(plan.refused, []);
});

test('a plist present but not loaded is still moved aside (no bootout)', () => {
  const plan = rec.planReconcile({ config: { entries: [entry('com.bwsc.x')] }, loaded: LIST, presentPlists: ['com.bwsc.x'], now: NOW });
  assert.deepEqual(plan.actions, [{ type: 'move-plist', label: 'com.bwsc.x' }]);
});

test('refuses checkout-sync and keep-list labels, even under another prefix', () => {
  const config = { entries: [
    entry('com.broadwayscore.checkout-sync'),
    entry('com.broadwayscore.cookie-renew'),
    entry('com.bwsc.wsj-cookie-refresh'),
    entry('com.broadwayscore.deploy-heartbeat'),
    entry('com.bwsc.checkout-sync'),
  ] };
  const plan = rec.planReconcile({ config, loaded: LIST, presentPlists: config.entries.map(e => e.label), now: NOW });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.refused.length, 5);
});

test('rejects malformed entries and path-traversal labels', () => {
  const config = { entries: [
    entry('../evil'), entry('com.bwsc.a', { retiredAt: '10/11/2026' }),
    { label: 'com.bwsc.b', retiredAt: '2026-10-01', replacedBy: [] }, null,
  ] };
  const plan = rec.planReconcile({ config, loaded: LIST, presentPlists: [], now: NOW });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.refused.length, 4);
});

test('waits out the grace period after retiredAt', () => {
  const config = { entries: [entry('com.bwsc.opening-night-monitor', { retiredAt: '2026-10-11' })] };
  const early = rec.planReconcile({ config, loaded: LIST, presentPlists: [], now: new Date('2026-10-13T23:00:00Z') });
  assert.deepEqual(early.actions, []);
  assert.deepEqual(early.waiting, [{ label: 'com.bwsc.opening-night-monitor', actFrom: '2026-10-14' }]);
  const due = rec.planReconcile({ config, loaded: LIST, presentPlists: [], now: new Date('2026-10-14T00:00:00Z') });
  assert.deepEqual(due.actions, [{ type: 'bootout', label: 'com.bwsc.opening-night-monitor' }]);
});

test('second run after applying is a no-op', () => {
  const config = { entries: [entry('com.bwsc.opening-night-monitor')] };
  const first = rec.planReconcile({ config, loaded: LIST, presentPlists: ['com.bwsc.opening-night-monitor'], now: NOW });
  assert.equal(first.actions.length, 2);
  const after = LIST.split('\n').filter(l => !l.endsWith('com.bwsc.opening-night-monitor')).join('\n');
  const second = rec.planReconcile({ config, loaded: after, presentPlists: [], now: NOW });
  assert.deepEqual(second, { actions: [], refused: [], waiting: [] });
});

test('applyPlan renames the plist without clobbering an earlier retired copy and logs one line per action', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-retired-'));
  try {
    fs.writeFileSync(path.join(dir, 'com.bwsc.x.plist'), '<plist/>');
    fs.writeFileSync(path.join(dir, 'com.bwsc.x.plist.retired-2026-10-20'), 'older');
    const calls = [];
    const lines = [];
    rec.applyPlan(
      { actions: [{ type: 'move-plist', label: 'com.bwsc.x' }, { type: 'bootout', label: 'com.bwsc.x' }], refused: [], waiting: [] },
      { dir, uid: 501, now: NOW, log: l => lines.push(l), run: (...a) => calls.push(a) },
    );
    assert.deepEqual(calls[0].slice(0, 2), ['launchctl', ['bootout', 'gui/501/com.bwsc.x']]);
    assert.ok(!fs.existsSync(path.join(dir, 'com.bwsc.x.plist')));
    assert.equal(fs.readFileSync(path.join(dir, 'com.bwsc.x.plist.retired-2026-10-20'), 'utf8'), 'older');
    assert.ok(fs.existsSync(path.join(dir, 'com.bwsc.x.plist.retired-2026-10-20.2')));
    assert.equal(lines.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applyPlan survives a failing bootout', () => {
  const lines = [];
  rec.applyPlan({ actions: [{ type: 'bootout', label: 'com.bwsc.x' }], refused: [], waiting: [] },
    { dir: os.tmpdir(), uid: 501, log: l => lines.push(l), run: () => { throw Object.assign(new Error('x'), { stderr: 'Boot-out failed: 3: No such process' }); } });
  assert.match(lines[0], /bootout com\.bwsc\.x: FAILED \(Boot-out failed/);
});

test('tracked config/mac-retired.json is valid and every watcher points at real code', () => {
  const config = rec.readConfig(path.join(ROOT, 'config/mac-retired.json'));
  assert.ok(config.entries.length >= 1);
  for (const e of config.entries) {
    assert.equal(rec.validateEntry(e), null, `${e.label}: ${rec.validateEntry(e)}`);
    assert.ok(e.replacedBy.length > 0, `${e.label}: replacedBy is empty`);
    assert.ok(e.watchers.length > 0, `${e.label}: name the pagers/health checks that watched it`);
    for (const w of e.watchers) {
      const src = fs.readFileSync(path.join(ROOT, w.file), 'utf8');
      assert.ok(src.includes(w.conditionKey), `${e.label}: ${w.file} no longer contains ${w.conditionKey}`);
    }
  }
});

test('heartbeat posts on a new sha or after REPOST_MS, not every tick', () => {
  const sha = 'a'.repeat(40);
  assert.equal(hb.shouldPost({ sha, last: null, now: NOW }), true);
  assert.equal(hb.shouldPost({ sha, last: { sha: 'b'.repeat(40), at: NOW.toISOString() }, now: NOW }), true);
  assert.equal(hb.shouldPost({ sha, last: { sha, at: new Date(NOW - 3600e3).toISOString() }, now: NOW }), false);
  assert.equal(hb.shouldPost({ sha, last: { sha, at: new Date(NOW - hb.REPOST_MS).toISOString() }, now: NOW }), true);
  assert.equal(hb.shouldPost({ sha: 'not-a-sha', last: null, now: NOW }), false);
  assert.ok(hb.statusArgs({ repo: 'o/r', sha, now: NOW }).includes(`context=${hb.STATUS_CONTEXT}`));
});

test('duplicate entries and empty watchers are refused, not silently dropped', () => {
  const config = { entries: [
    entry('com.bwsc.dup', { watchers: [{ conditionKey: 'k', file: 'f' }] }),
    entry('com.bwsc.dup', { watchers: [{ conditionKey: 'k', file: 'f' }], retiredAt: '2026-09-01' }),
    entry('com.bwsc.nowatch', { watchers: [] }),
  ] };
  const plan = rec.planReconcile({ config, loaded: '', presentPlists: ['com.bwsc.dup', 'com.bwsc.nowatch'], now: NOW });
  assert.deepEqual(plan.refused.map(r => [r.label, r.reason]), [
    ['com.bwsc.dup', 'duplicate entry'],
    ['com.bwsc.nowatch', 'watchers must name the pagers/health checks that watched the job'],
  ]);
  assert.deepEqual(plan.actions, [{ type: 'move-plist', label: 'com.bwsc.dup' }]);
});

test('a loaded label whose plist has another filename is flagged every tick', () => {
  const plan = rec.planReconcile({ config: { entries: [entry('com.bwsc.opening-night-monitor')] }, loaded: LIST, presentPlists: [], now: NOW });
  assert.deepEqual(plan.actions, [{ type: 'bootout', label: 'com.bwsc.opening-night-monitor' }]);
  assert.match(plan.refused[0].reason, /no com\.bwsc\.opening-night-monitor\.plist/);
});

test('outcomeStatus reports partial retirements as failure and quiet ticks as nothing', () => {
  assert.equal(rec.outcomeStatus({ done: [], failed: [] }), null);
  assert.deepEqual(rec.outcomeStatus({ done: [{ type: 'move-plist', label: 'a' }, { type: 'bootout', label: 'a' }], failed: [] }), { state: 'success', description: 'retired a' });
  const f = rec.outcomeStatus({ done: [{ type: 'move-plist', label: 'a' }], failed: [{ type: 'bootout', label: 'a', reason: 'boom' }] });
  assert.equal(f.state, 'failure');
  assert.match(f.description, /FAILED bootout a: boom/);
});
