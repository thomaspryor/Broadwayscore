// BRO-6615: lost nightly pushes. Requires the REAL disqualifier and registry
// (CLAUDE.md §15), so a registry or predicate change fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { disqualifyingPath } = require('../../scripts/lib/api-fallback-disqualifier.js');
const registry = require('../../scripts/lib/reconcile-merged-json.js');

test('press-night records are API-fallback safe (press-night-probe run 40983253026 lost 7/7 attempts on this path)', () => {
  assert.equal(disqualifyingPath(['data/audit/press-night/a-few-good-men-2026-2026-10-29.json'], registry), null);
  assert.equal(disqualifyingPath(['data/audit/press-night/the-lives-of-others-west-end-2026-2026-10-29.json'], registry), null);
});

test('other unaudited data/audit paths still disqualify', () => {
  for (const p of [
    'data/audit/press-night-unregistered.json',
    'data/audit/press-night/nested/x.json',
    'data/audit/press-night/notes.txt',
    'data/audit/nobody-registered-me.json',
  ]) {
    assert.equal(disqualifyingPath([p], registry), p, p);
  }
});

test('a press-night record riding with shows.json still disqualifies the whole push', () => {
  assert.equal(disqualifyingPath(['data/audit/press-night/x-2026-10-29.json', 'data/shows.json'], registry), 'data/shows.json');
});

// ── review-texts: an exhausted push leaves added reviews recoverable ──────────
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUSH = join(ROOT, 'scripts/lib/push-with-retry.sh');
const RESCUE = join(ROOT, 'scripts/lib/push-rescue.js');
const rescue = require('../../scripts/lib/push-rescue.js');

test('recoverableAdds keeps added review files and pending stubs only', () => {
  const rows = rescue.parseNameStatusZ(['A', 'show-a/nyt--jane.json', 'A', '_pending/show-a/sun--4b16c00e.json', 'M', 'show-a/old.json',
    'A', 'failed-fetches.json', 'A', 'show-a/failed-fetches.json', 'A', '_archive/x/y.json', 'D', 'show-b/gone.json', ''].join('\0'));
  assert.deepEqual(rescue.recoverableAdds(rows), ['show-a/nyt--jane.json', '_pending/show-a/sun--4b16c00e.json']);
});

test('rescue ref names round-trip and reject a short base', () => {
  const base = 'a'.repeat(40);
  const ref = rescue.rescueRefName({ now: Date.UTC(2026, 9, 30, 6, 23, 5), runId: '41013824281.1', base });
  assert.equal(ref, `push-rescue/20261030T062305Z-41013824281.1-${base}`);
  assert.deepEqual(rescue.parseRescueRef(`refs/heads/${ref}`), { stamp: '20261030T062305Z', at: Date.UTC(2026, 9, 30, 6, 23, 5), runId: '41013824281.1', base });
  assert.equal(rescue.parseRescueRef('push-rescue/garbage'), null);
  assert.throws(() => rescue.rescueRefName({ now: 0, runId: 'x', base: 'abc' }));
});

test('replayPlan never overwrites a file on main nor resurrects one main changed since', () => {
  const plan = rescue.replayPlan({
    adds: ['s/new.json', 's/landed.json', '_pending/s/drained.json', 's/clash.json'],
    mainBlob: new Map([['s/landed.json', 'b1'], ['s/clash.json', 'main-version']]),
    touchedOnMain: new Set(['_pending/s/drained.json']),
    rescueBlob: new Map([['s/new.json', 'n'], ['s/landed.json', 'b1'], ['_pending/s/drained.json', 'd'], ['s/clash.json', 'ours']]),
  });
  assert.deepEqual(plan.restore, ['s/new.json']);
  assert.deepEqual(plan.skipped.map((s) => s.path), ['s/landed.json', '_pending/s/drained.json']);
  assert.deepEqual(plan.conflicts.map((c) => c.path), ['s/clash.json']);
  assert.equal(plan.keepForHuman, true);
});

test('replayPlan: the same file in two rescue branches is restored once; a different version is a conflict', () => {
  const base = { mainBlob: new Map(), touchedOnMain: new Set() };
  const same = rescue.replayPlan({ ...base, adds: ['s/a.json'], rescueBlob: new Map([['s/a.json', 'x']]), claimed: new Map([['s/a.json', 'x']]) });
  assert.deepEqual(same.restore, []);
  assert.equal(same.keepForHuman, false);
  const diff = rescue.replayPlan({ ...base, adds: ['s/a.json'], rescueBlob: new Map([['s/a.json', 'y']]), claimed: new Map([['s/a.json', 'x']]) });
  assert.equal(diff.keepForHuman, true);
});

test('prunable keeps a branch until every restored file is on main with the restored content', () => {
  const m = { refs: [
    { ref: 'a', restored: ['x'], restoredBlobs: { x: 'bx' } },
    { ref: 'b', restored: ['y'], restoredBlobs: { y: 'by' } },
    { ref: 'c', restored: [], keepForHuman: true },
    { ref: 'd', restored: [] },
    { ref: 'e', restored: ['z'], restoredBlobs: { z: 'ours' } },
  ] };
  const onMain = { x: 'bx', z: 'someone-else' };
  assert.deepEqual(rescue.prunable(m, (p) => onMain[p] || null).map((r) => r.ref), ['a', 'd']);
});

test('END TO END: every push to main fails, the new review lands on a rescue branch, and replay restores it', () => {
  const work = mkdtempSync(join(tmpdir(), 'bro6615-'));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const remote = join(work, 'broadway-review-texts.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    g(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const seed = join(work, 'seed');
    execFileSync('git', ['clone', '-q', remote, seed], { stdio: 'ignore' });
    for (const [k, v] of [['user.email', 't@t.t'], ['user.name', 't']]) g(seed, 'config', k, v);
    mkdirSync(join(seed, 'show-a'));
    writeFileSync(join(seed, 'show-a/old--critic.json'), '{"url":"https://example.com/old","fullText":"x"}\n');
    g(seed, 'add', '-A'); g(seed, 'commit', '-qm', 'seed'); g(seed, 'push', '-q', 'origin', 'HEAD:main');

    // The job: adds one review and one pending stub, then every main push is refused.
    const job = join(work, 'job');
    execFileSync('git', ['clone', '-q', remote, job], { stdio: 'ignore' });
    for (const [k, v] of [['user.email', 't@t.t'], ['user.name', 't']]) g(job, 'config', k, v);
    mkdirSync(join(job, '_pending/show-a'), { recursive: true });
    const review = '{"url":"https://example.com/sun-review","criticName":"Jane Doe","fullText":"A new review."}\n';
    writeFileSync(join(job, 'show-a/sun--jane-doe.json'), review);
    writeFileSync(join(job, '_pending/show-a/sun--4b16c00e.json'), '{"url":"https://example.com/stub"}\n');
    g(job, 'add', '-A'); g(job, 'commit', '-qm', 'poller adds');
    writeFileSync(join(remote, 'hooks/pre-receive'), '#!/bin/sh\nwhile read o n ref; do [ "$ref" = refs/heads/main ] && { echo "main is busy"; exit 1; }; done\nexit 0\n', { mode: 0o755 });

    const r = spawnSync('bash', [PUSH, '2', 'main'], {
      cwd: job, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PUSH_API_FALLBACK_DISABLE: '1', PUSH_SKIP_LEDGER: '1', PUSH_SKIP_FAILURE_LEDGER: '1', PUSH_FAILURE_LOG: '/dev/null', DISK_PREFLIGHT_FLOOR_GB: '0', PUSH_DEADLINE_SEC: '60', GITHUB_RUN_ID: '777' },
    });
    assert.notEqual(r.status, 0, 'the push must have failed');
    const out = r.stdout + r.stderr;
    assert.match(out, /new reviews rescued::2 new review file\(s\)/, out.slice(-3000));
    const refs = g(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/push-rescue/').trim().split('\n').filter(Boolean);
    assert.equal(refs.length, 1);
    assert.match(refs[0], /^push-rescue\/\d{8}T\d{6}Z-777-[0-9a-f]{40}$/);
    assert.equal(g(remote, 'show', `${refs[0]}:show-a/sun--jane-doe.json`), review);

    // Next hour: main accepts pushes again; replay restores onto a fresh clone.
    rmSync(join(remote, 'hooks/pre-receive'));
    const fresh = join(work, 'fresh');
    execFileSync('git', ['clone', '-q', remote, fresh], { stdio: 'ignore' });
    assert.equal(existsSync(join(fresh, 'show-a/sun--jane-doe.json')), false);
    const manifest = join(work, 'manifest.json');
    execFileSync(process.execPath, [RESCUE, 'replay', `--manifest=${manifest}`], { cwd: fresh, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
    assert.equal(readFileSync(join(fresh, 'show-a/sun--jane-doe.json'), 'utf8'), review);
    assert.equal(existsSync(join(fresh, '_pending/show-a/sun--4b16c00e.json')), true);

    // Prune only after the files are on main.
    execFileSync(process.execPath, [RESCUE, 'prune', `--manifest=${manifest}`], { cwd: fresh, encoding: 'utf8' });
    assert.equal(g(remote, 'for-each-ref', 'refs/heads/push-rescue/').trim().split('\n').filter(Boolean).length, 1, 'kept: not on main yet');
    for (const [k, v] of [['user.email', 't@t.t'], ['user.name', 't']]) g(fresh, 'config', k, v);
    g(fresh, 'add', '-A'); g(fresh, 'commit', '-qm', 'replay'); g(fresh, 'push', '-q', 'origin', 'HEAD:main');
    execFileSync(process.execPath, [RESCUE, 'prune', `--manifest=${manifest}`], { cwd: fresh, encoding: 'utf8' });
    assert.equal(g(remote, 'for-each-ref', 'refs/heads/push-rescue/').trim(), '', 'deleted once on main');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
