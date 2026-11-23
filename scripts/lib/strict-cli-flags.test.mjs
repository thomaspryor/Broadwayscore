import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateArgs } = require('./strict-cli-flags.js');
const here = path.dirname(new URL(import.meta.url).pathname);

test('validateArgs', () => {
  const spec = { flags: ['--dry-run'], valueFlags: ['--root'] };
  assert.equal(validateArgs(['--help'], spec).help, true);
  assert.equal(validateArgs(['--dry-run', '--root', '/x'], spec).error, null);
  assert.equal(validateArgs(['--root=/x'], spec).error, null);
  assert.match(validateArgs(['--dryrun'], spec).error, /unrecognised/);
  assert.match(validateArgs(['stray'], spec).error, /unrecognised/);
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strictflags-'));
  const d = path.join(root, 'old-dir');
  fs.mkdirSync(d);
  const t = new Date(Date.now() - 30 * 86400e3);
  fs.utimesSync(d, t, t);
  return { root, d };
}

for (const script of ['reap-stale-tmp.js', 'reap-temp-checkouts.js', 'tmpdir-cleanup-audit.js']) {
  test(`${script}: --help exits 0, unknown flag exits 2`, () => {
    const h = spawnSync('node', [path.join(here, script), '--help']);
    assert.equal(h.status, 0);
    assert.match(h.stdout.toString(), /usage|node scripts/i);
    const b = spawnSync('node', [path.join(here, script), '--dryrun']);
    assert.equal(b.status, 2);
    assert.match(b.stderr.toString(), /unrecognised argument: --dryrun/);
  });
}

test('reap-stale-tmp: --help and --dryrun remove nothing on a fixture root', () => {
  const { root, d } = fixtureRoot();
  const script = path.join(here, 'reap-stale-tmp.js');
  for (const a of ['--help', '--dryrun', '--dry_run']) {
    spawnSync('node', [script, '--root', root, a]);
    assert.ok(fs.existsSync(d), `${a} must not delete`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('gc-merged-worktrees.sh: --help 0, typo 2, nothing run', () => {
  const sh = path.join(here, '..', 'gc-merged-worktrees.sh');
  assert.equal(spawnSync('bash', [sh, '--help']).status, 0);
  assert.equal(spawnSync('bash', [sh, '--dryrun']).status, 2);
});
