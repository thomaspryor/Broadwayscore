// Tests for scripts/lib/cloud-memory-reconcile.js (BRO-5074): the CI path that
// keeps cloud-memory/ current from claude-config without the Mac.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planReconcile, nextDivergence, reportChanged, reconcile, massRemovalError, dirHistory,
} = require('./cloud-memory-reconcile.js');

const hist = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe('planReconcile', () => {
  it('adds a note only claude-config has', () => {
    const p = planReconcile({ mirror: {}, source: { 'a.md': 's1' } });
    assert.deepEqual(p.add, ['a.md']);
  });

  it('updates when the mirror holds a version the Mac already saw', () => {
    const p = planReconcile({
      mirror: { 'a.md': 'v1' }, source: { 'a.md': 'v2' }, sourceHistory: hist({ 'a.md': ['v2', 'v1'] }),
    });
    assert.deepEqual(p.update, ['a.md']);
    assert.deepEqual(p.merge, []);
  });

  it('merges a cloud edit against the newest version both sides share', () => {
    const p = planReconcile({
      mirror: { 'a.md': 'cloud' }, source: { 'a.md': 'v3' },
      sourceHistory: hist({ 'a.md': ['v3', 'v2', 'v1'] }),
      mirrorHistory: { 'a.md': ['cloud', 'v2', 'v1'] },
    });
    assert.deepEqual(p.merge, [{ name: 'a.md', base: 'v2' }]);
    assert.deepEqual(p.update, []);
  });

  it('never overwrites a cloud edit with no shared version', () => {
    const p = planReconcile({
      mirror: { 'a.md': 'cloud' }, source: { 'a.md': 'mac' },
      sourceHistory: hist({ 'a.md': ['mac'] }), mirrorHistory: { 'a.md': ['cloud'] },
    });
    assert.deepEqual(p.diverged, [{ name: 'a.md', reason: 'no-common-version' }]);
    assert.deepEqual([...p.update, ...p.merge, ...p.remove], []);
  });

  it('skips a note whose merged-in claude-config version is still current', () => {
    const p = planReconcile({
      mirror: { 'a.md': 'merged' }, source: { 'a.md': 'v2' },
      sourceHistory: hist({ 'a.md': ['v2', 'v1'] }), mirrorHistory: { 'a.md': ['merged', 'cloud', 'v1'] },
      incorporated: { 'a.md': { source: 'v2', result: 'merged' } },
    });
    assert.deepEqual(p.alreadyMerged, ['a.md']);
    assert.deepEqual(p.merge, []);
  });

  it('removes a note the Mac deleted only when the Mac had seen that exact content', () => {
    const p = planReconcile({
      mirror: { 'gone.md': 'v1', 'cloud.md': 'c1', 'edited.md': 'e2' }, source: {},
      sourceHistory: hist({ 'gone.md': ['v1'], 'edited.md': ['e1'] }),
    });
    assert.deepEqual(p.remove, ['gone.md']);
    assert.deepEqual(p.diverged.map((d) => d.name), ['cloud.md', 'edited.md']);
  });

  it('ignores MEMORY.md, dotfiles and non-notes', () => {
    const p = planReconcile({
      mirror: { 'MEMORY.md': 'x' }, source: { 'MEMORY.md': 'y', '.hidden.md': 'z', 'notes.txt': 'q' },
    });
    assert.deepEqual([...p.add, ...p.update, ...p.remove, ...p.diverged, ...p.merge], []);
  });
});

describe('nextDivergence / reportChanged', () => {
  it('keeps the first-seen time of a name that is still waiting and drops cleared ones', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const out = nextDivergence(
      [{ name: 'a.md', firstSeenAt: '2026-10-01T00:00:00Z' }, { name: 'gone.md', firstSeenAt: '2026-10-02T00:00:00Z' }],
      [{ name: 'a.md', reason: 'only-in-mirror' }, { name: 'b.md', reason: 'cloud-edit-merged' }],
      now,
    );
    assert.deepEqual(out, [
      { name: 'a.md', reason: 'only-in-mirror', firstSeenAt: '2026-10-01T00:00:00Z' },
      { name: 'b.md', reason: 'cloud-edit-merged', firstSeenAt: '2026-10-11T00:00:00.000Z' },
    ]);
  });

  it('treats a checkedAt-only difference as no change', () => {
    assert.equal(reportChanged({ checkedAt: '1', x: 1 }, { checkedAt: '2', x: 1 }), false);
    assert.equal(reportChanged({ checkedAt: '1', x: 1 }, { checkedAt: '1', x: 2 }), true);
  });

  it('treats a new claude-config commit alone as no change', () => {
    assert.equal(reportChanged({ source: { commit: 'a' }, x: 1 }, { source: { commit: 'b' }, x: 1 }), false);
  });
});

describe('massRemovalError', () => {
  const plan = (n) => ({ remove: Array.from({ length: n }, (_, i) => `n${i}.md`) });
  it('allows a handful of Mac deletions', () => {
    assert.equal(massRemovalError(plan(5), 20), null);
    assert.equal(massRemovalError(plan(69), 690), null);
  });
  it('refuses to wipe the mirror when claude-config looks emptied', () => {
    assert.match(massRemovalError(plan(70), 690), /refusing to remove 70 of 690/);
    assert.match(massRemovalError(plan(6), 20), /limit 5/);
  });
});

describe('dirHistory', () => {
  it('sees a blob that only exists on a merged side branch', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hist-'));
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    try {
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@e.com'); g('config', 'user.name', 't');
      g('config', 'commit.gpgsign', 'false');
      fs.mkdirSync(path.join(repo, 'm'));
      fs.writeFileSync(path.join(repo, 'm/a.md'), 'v1\n'); g('add', '-A'); g('commit', '-qm', 'v1');
      g('checkout', '-qb', 'side');
      fs.writeFileSync(path.join(repo, 'm/a.md'), 'side\n'); g('commit', '-qam', 'side');
      fs.writeFileSync(path.join(repo, 'm/a.md'), 'v1\n'); g('commit', '-qam', 'back');
      g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', '-m', 'merge', 'side');
      const blobs = dirHistory(repo, 'HEAD', 'm')['a.md'] || [];
      const want = execFileSync('git', ['-C', repo, 'rev-parse', 'side~1:m/a.md'], { encoding: 'utf8' }).trim();
      assert.ok(blobs.includes(want), `side-branch blob ${want} missing from ${blobs}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

// End to end against two real git repos: "config" plays claude-config (the
// Mac's memory history), "mirror" plays Broadwayscore's cloud-memory/.
describe('reconcile end to end', () => {
  const g = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const init = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    g(dir, 'init', '-q');
    g(dir, 'config', 'user.email', 't@example.com');
    g(dir, 'config', 'user.name', 't');
    g(dir, 'config', 'commit.gpgsign', 'false');
  };
  const put = (repo, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const commit = (repo, msg) => { g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', msg); };

  it('catches the mirror up, keeps cloud edits, and records what waits for the Mac', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reconcile-'));
    const config = path.join(root, 'config');
    const mirror = path.join(root, 'mirror');
    const SD = 'projects/x/memory';
    init(config); init(mirror);
    try {
      // Day 1: Mac syncs both repos identically.
      const v1 = '# Notes\n\nentry one\n';
      put(config, `${SD}/log.md`, v1); put(config, `${SD}/stale.md`, 'old\n'); put(config, `${SD}/MEMORY.md`, 'index v1\n');
      commit(config, 'day1');
      put(mirror, 'cloud-memory/log.md', v1); put(mirror, 'cloud-memory/stale.md', 'old\n');
      put(mirror, 'cloud-memory/deleted.md', 'bye\n'); put(mirror, 'cloud-memory/MEMORY.md', 'index cloud\n');
      put(config, `${SD}/deleted.md`, 'bye\n'); commit(config, 'add deleted');
      fs.rmSync(path.join(config, SD, 'deleted.md')); commit(config, 'owner deletes');
      commit(mirror, 'mirror day1');

      // Then the Mac's mirror push breaks. Mac keeps writing, cloud keeps writing.
      put(config, `${SD}/log.md`, `${v1}entry two (mac)\n`);
      put(config, `${SD}/stale.md`, 'new\n');
      put(config, `${SD}/fresh.md`, 'brand new\n');
      put(config, `${SD}/MEMORY.md`, 'index v2\n');
      commit(config, 'mac edits');
      put(mirror, 'cloud-memory/log.md', `${v1}entry from cloud\n`);
      put(mirror, 'cloud-memory/cloud-only.md', 'cloud note\n');
      commit(mirror, 'cloud edits');

      const now = new Date('2026-10-11T12:00:00Z');
      const { plan, report } = reconcile({ sourceRepo: config, sourceDir: SD, mirrorRepo: mirror, mirrorDir: 'cloud-memory', now });
      const read = (n) => fs.readFileSync(path.join(mirror, 'cloud-memory', n), 'utf8');

      assert.deepEqual(plan.add, ['fresh.md']);
      assert.deepEqual(plan.update, ['stale.md']);
      assert.deepEqual(plan.remove, ['deleted.md']);
      assert.equal(read('fresh.md'), 'brand new\n');
      assert.equal(read('stale.md'), 'new\n');
      assert.equal(fs.existsSync(path.join(mirror, 'cloud-memory', 'deleted.md')), false);
      // Both sides' lines survive the merge; no conflict markers.
      const log = read('log.md');
      assert.match(log, /entry two \(mac\)/);
      assert.match(log, /entry from cloud/);
      assert.doesNotMatch(log, /^(<<<<<<<|>>>>>>>)/m);
      // Never touched: the index and the cloud-only note.
      assert.equal(read('MEMORY.md'), 'index cloud\n');
      assert.equal(read('cloud-only.md'), 'cloud note\n');
      assert.deepEqual(report.waitingForMac.map((d) => [d.name, d.reason]), [
        ['cloud-only.md', 'only-in-mirror'], ['log.md', 'cloud-edit-merged'],
      ]);
      assert.deepEqual(report.lastApplied.merged, ['log.md']);

      // Second run on the committed result is a no-op for the files and keeps first-seen times.
      commit(mirror, 'reconciled');
      const again = reconcile({
        sourceRepo: config, sourceDir: SD, mirrorRepo: mirror, mirrorDir: 'cloud-memory',
        previousReport: report, now: new Date('2026-10-13T12:00:00Z'),
      });
      assert.equal(g(mirror, 'status', '--porcelain'), '');
      assert.deepEqual(again.report.waitingForMac.map((d) => d.firstSeenAt), [
        '2026-10-11T12:00:00.000Z', '2026-10-11T12:00:00.000Z',
      ]);
      assert.equal(reportChanged(report, again.report), false);
      assert.deepEqual(again.plan.merge, []);

      // The Mac then adds another entry: merged against the version merged in
      // last time, so nothing already in the mirror is duplicated.
      put(config, `${SD}/log.md`, `${v1}entry two (mac)\nentry three (mac)\n`);
      commit(config, 'mac adds more');
      const third = reconcile({
        sourceRepo: config, sourceDir: SD, mirrorRepo: mirror, mirrorDir: 'cloud-memory',
        previousReport: again.report, now: new Date('2026-10-14T12:00:00Z'),
      });
      assert.equal(third.plan.merge.length, 1);
      const log3 = read('log.md');
      for (const line of ['entry one', 'entry two (mac)', 'entry three (mac)', 'entry from cloud']) {
        assert.equal(log3.split(line).length - 1, 1, `${line} appears exactly once`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

// The digest row (scripts/health-check.js) that reads the report this writes.
describe('cloudMemoryDriftResults (daily digest)', () => {
  const { cloudMemoryDriftResults } = require('../health-check.js');
  const now = new Date('2026-10-11T12:00:00Z');

  it('emits nothing for no report, and pass rows (BRO-3833) for a healthy one', () => {
    assert.deepEqual(cloudMemoryDriftResults(null, now), []);
    const rows = cloudMemoryDriftResults({
      waitingForMac: [{ name: 'a.md', reason: 'only-in-mirror', firstSeenAt: '2026-10-10T00:00:00Z' }],
    }, now);
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [
      ['Memory: cloud mirror reconcile failing', 'pass'],
      ['Memory: cloud notes not reaching the Mac', 'pass'],
    ]);
  });

  it('warns past 48h naming the oldest note', () => {
    const rows = cloudMemoryDriftResults({
      waitingForMac: [
        { name: 'new.md', reason: 'only-in-mirror', firstSeenAt: '2026-10-11T00:00:00Z' },
        { name: 'b.md', reason: 'cloud-edit-merged', firstSeenAt: '2026-10-08T12:00:00Z' },
        { name: 'old.md', reason: 'no-common-version', firstSeenAt: '2026-10-01T12:00:00Z' },
      ],
    }, now).filter((r) => r.status !== 'pass');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'warn');
    assert.match(rows[0].message, /^2 cloud-memory note/);
    assert.match(rows[0].message, /Oldest: old\.md \(no-common-version, 240h\)/);
  });

  it('warns when the reconcile could not read claude-config', () => {
    const rows = cloudMemoryDriftResults({ error: 'could not clone', waitingForMac: [] }, now);
    // No pass row for the notes check: a failed reconcile proves nothing about it.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Memory: cloud mirror reconcile failing');
  });
});
