// BRO-4643: land tip carrying a GitHub skip marker gets a marker-free empty trigger child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('./land-skip-ci-marker.js');
const { hasSkipCiMarker } = require('./landing-ci-coverage.js');
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'land-skip-ci-marker.js');

function repoWithTip(message, date = '2026-10-04T12:00:00Z') {
  const dir = mkdtempSync(join(tmpdir(), 'land-skip-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const g = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  g('init', '-q'); g('commit', '--allow-empty', '-q', '-m', 'base');
  g('commit', '--allow-empty', '-q', '-m', message);
  return { dir, g, tip: g('rev-parse', 'HEAD') };
}

for (const marker of ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]', '[SKIP CI]']) {
  test(`marker ${marker} on tip -> empty marker-free child`, () => {
    const { dir, g, tip } = repoWithTip(`audit: refresh report ${marker}`);
    const out = lib.ensureTriggerCommit(tip, dir);
    assert.match(out, /^[0-9a-f]{40}$/);
    assert.equal(g('rev-parse', `${out}^`), tip);
    assert.equal(g('rev-parse', `${out}^{tree}`), g('rev-parse', `${tip}^{tree}`));
    assert.equal(hasSkipCiMarker(g('log', '-1', '--format=%B', out)), false);
  });
}

test('skip-checks trailer on tip is detected', () => {
  const { dir, tip } = repoWithTip('data: x\n\nskip-checks: true');
  assert.ok(lib.ensureTriggerCommit(tip, dir));
});

test('tip without a marker -> null (nothing to do)', () => {
  const { dir, tip } = repoWithTip('feat: real change');
  assert.equal(lib.ensureTriggerCommit(tip, dir), null);
});

test('deterministic: same tip yields the same sha (resume path stays valid)', () => {
  const { dir, tip } = repoWithTip('audit: x [skip ci]');
  const a = lib.ensureTriggerCommit(tip, dir);
  const b = lib.ensureTriggerCommit(tip, dir);
  assert.equal(a, b);
});

test('CLI: exit 10 + sha on marker, exit 0 + no output otherwise, exit 2 on bad sha', () => {
  const m = repoWithTip('audit: x [skip ci]');
  const r = spawnSync('node', [CLI, `--sha=${m.tip}`, `--cwd=${m.dir}`], { encoding: 'utf8' });
  assert.equal(r.status, 10);
  assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
  const c = repoWithTip('feat: y');
  const r2 = spawnSync('node', [CLI, `--sha=${c.tip}`, `--cwd=${c.dir}`], { encoding: 'utf8' });
  assert.equal(r2.status, 0); assert.equal(r2.stdout.trim(), '');
  assert.equal(spawnSync('node', [CLI, '--sha=deadbeef', `--cwd=${c.dir}`], { encoding: 'utf8' }).status, 2);
});

test('land script wires the marker check before the land/** push and pushes push_tip', async () => {
  const { readFileSync } = await import('node:fs');
  const sh = readFileSync(join(dirname(CLI), '..', 'merge-worktree-to-main.sh'), 'utf8');
  const iCheck = sh.indexOf('land-skip-ci-marker.js');
  const iPush = sh.indexOf('push origin "$push_tip:refs/heads/$land_name"');
  assert.ok(iCheck > 0 && iPush > iCheck, 'marker check must precede the push');
  assert.doesNotMatch(sh, /push (--force )?origin "\$tip:refs\/heads\/\$land_name"/, 'push must use push_tip, not the raw tip');
});
