// BRO-5217: cloud sessions get plain copies of the core-data files, refreshed
// at session start, instead of symlinks into the clone outside the working
// directory (every Bash read of a link stopped on an unanswerable permission
// prompt). Drives the real setup-local-data.sh / cloud-bootstrap-data.sh in a
// throwaway project + fake HOME (CLAUDE.md §15); never the real clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cloudCopyWriteRefusal, cloudAuditDryRun } = require('./cloud-data-copy.js');
const { getLocalSymlinkFiles, findStaleCopies } = require('./core-data-files.js');
const { atomicWriteShowsJson } = require('./atomic-shows-write.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
const SYMLINK_FILES = getLocalSymlinkFiles();

// Every fixture root, removed on exit too: a run killed by a timeout left 1.7 GB dirs behind
// (BRO-5422/5443). The real fix is BSC_ATTACHED_REPOS_DIR in run(): the bootstrap no longer
// copies the session-attached review-texts clone into the fixture.
const roots = new Set();
const removeRoots = () => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ } } };
process.on('exit', removeRoots);
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { removeRoots(); process.exit(1); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5217-'));
  roots.add(root);
  const home = path.join(root, 'home');
  const clone = path.join(home, 'broadway-scorecard-data');
  fs.mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q', '-b', 'main');
  for (const f of SYMLINK_FILES) fs.writeFileSync(path.join(clone, f), JSON.stringify({ f, v: 1 }));
  fs.writeFileSync(path.join(clone, 'awards.json'), '{"v":1}');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'seed');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'data'));
  for (const f of ['setup-local-data.sh', 'cloud-bootstrap-data.sh', 'lib/core-data-clone-guard.sh']) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(proj, 'scripts', f));
  }
  return { root, home, clone, proj, data: path.join(proj, 'data') };
}

function run(fx, script, args, env) {
  return execFileSync('bash', [path.join(fx.proj, 'scripts', script), ...args], {
    cwd: fx.proj, encoding: 'utf8', stdio: 'pipe', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: fx.home, GIT_CONFIG_NOSYSTEM: '1', BSC_ATTACHED_REPOS_DIR: path.join(fx.root, 'attached'), ...env },
  });
}
const cloud = { CLAUDE_CODE_REMOTE: 'true' };
const linkInto = (fx) => { for (const f of SYMLINK_FILES) fs.symlinkSync(path.join(fx.clone, f), path.join(fx.data, f)); };
const isLink = (p) => fs.lstatSync(p).isSymbolicLink();
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('cloud setup-local-data.sh: plain copies, no links, no .pre-symlink-backup, marker = clone HEAD', () => {
  const fx = fixture();
  try {
    linkInto(fx);
    run(fx, 'setup-local-data.sh', ['--link-only'], cloud);
    run(fx, 'setup-local-data.sh', ['--link-only'], cloud); // second run over existing copies
    for (const f of SYMLINK_FILES) {
      const p = path.join(fx.data, f);
      assert.equal(isLink(p), false, `${f} is still a link`);
      assert.deepEqual(read(p), { f, v: 1 });
    }
    const left = fs.readdirSync(fx.data).filter((n) => /pre-symlink-backup|cloudcopy/.test(n));
    assert.deepEqual(left, []);
    assert.equal(fs.readFileSync(path.join(fx.data, '.core-data-sha'), 'utf8').trim(), git(fx.clone, 'rev-parse', 'HEAD').trim());
    assert.deepEqual(read(path.join(fx.data, 'awards.json')), { v: 1 });
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('off cloud (the Mac) and with the kill switch: links as before', () => {
  for (const env of [{}, { ...cloud, BSC_CLOUD_DATA_SYMLINK: '1' }]) {
    const fx = fixture();
    try {
      run(fx, 'setup-local-data.sh', ['--link-only'], env);
      for (const f of SYMLINK_FILES) assert.equal(isLink(path.join(fx.data, f)), true, `${f} ${JSON.stringify(env)}`);
      assert.equal(fs.existsSync(path.join(fx.data, '.core-data-sha')), false);
    } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
});

test('cloud bootstrap: converts snapshot links, re-copies on startup when the clone moved, keeps copies on compact', () => {
  const fx = fixture();
  try {
    linkInto(fx);
    run(fx, 'cloud-bootstrap-data.sh', [], { ...cloud, BSC_SESSION_EVENT: 'startup' });
    const shows = path.join(fx.data, 'shows.json');
    assert.equal(isLink(shows), false);
    assert.deepEqual(read(shows), { f: 'shows.json', v: 1 });

    fs.writeFileSync(path.join(fx.clone, 'shows.json'), JSON.stringify({ f: 'shows.json', v: 2 }));
    git(fx.clone, 'commit', '-qam', 'v2');
    run(fx, 'cloud-bootstrap-data.sh', [], { ...cloud, BSC_SESSION_EVENT: 'compact' });
    assert.deepEqual(read(shows), { f: 'shows.json', v: 1 }, 'compact must not overwrite the session copy');
    assert.deepEqual(findStaleCopies({ dataDir: fx.data, coreDataDir: fx.clone, files: getLocalSymlinkFiles() }), ['shows.json'], 'stale check sees the cloud copy');

    run(fx, 'cloud-bootstrap-data.sh', [], { ...cloud, BSC_SESSION_EVENT: 'startup' });
    assert.deepEqual(read(shows), { f: 'shows.json', v: 2 });
    assert.deepEqual(findStaleCopies({ dataDir: fx.data, coreDataDir: fx.clone, files: getLocalSymlinkFiles() }), []);
    assert.deepEqual(execFileSync('git', ['-C', fx.clone, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'clone untouched');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('writers refuse a cloud copy loudly; links, non-cloud and the scratch override are allowed', () => {
  const fx = fixture();
  try {
    linkInto(fx);
    const shows = path.join(fx.data, 'shows.json');
    assert.equal(cloudCopyWriteRefusal(shows, cloud), null, 'a link is not a cloud copy');
    run(fx, 'setup-local-data.sh', ['--link-only'], cloud);
    assert.match(cloudCopyWriteRefusal(shows, cloud), /pending-fixes/);
    assert.equal(cloudCopyWriteRefusal(shows, {}), null);
    assert.equal(cloudCopyWriteRefusal(shows, { ...cloud, BSC_ALLOW_CLOUD_COPY_WRITE: '1' }), null);
    const prev = process.env.CLAUDE_CODE_REMOTE;
    process.env.CLAUDE_CODE_REMOTE = 'true';
    try {
      assert.throws(() => atomicWriteShowsJson(shows, { f: 'shows.json', v: 9 }), /BRO-5217/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_REMOTE; else process.env.CLAUDE_CODE_REMOTE = prev;
    }
    assert.deepEqual(read(shows), { f: 'shows.json', v: 1 });
    // Public tracked data/*.json share atomicWriteJson and stay writable (ship-check P1).
    const playbill = path.join(fx.data, 'playbill-urls.json');
    fs.writeFileSync(playbill, '{}');
    assert.equal(cloudCopyWriteRefusal(playbill, cloud), null);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('kill switch after a conversion: copies and marker go, links come back', () => {
  const fx = fixture();
  try {
    run(fx, 'setup-local-data.sh', ['--link-only'], cloud);
    assert.equal(isLink(path.join(fx.data, 'shows.json')), false);
    run(fx, 'cloud-bootstrap-data.sh', [], { ...cloud, BSC_CLOUD_DATA_SYMLINK: '1' });
    for (const f of SYMLINK_FILES) assert.equal(isLink(path.join(fx.data, f)), true, f);
    assert.equal(fs.existsSync(path.join(fx.data, '.core-data-sha')), false);
    assert.deepEqual(fs.readdirSync(fx.data).filter((n) => /pre-symlink-backup/.test(n)), []);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('bootstrap never copies a review-texts clone from outside the fixture (BRO-5422)', () => {
  const fx = fixture();
  try {
    // A fake attached clone where the fixture says attached repos live: that one IS used...
    const rt = path.join(fx.root, 'attached', 'broadway-review-texts');
    fs.mkdirSync(rt, { recursive: true });
    git(rt, 'init', '-q', '-b', 'main');
    // ...while the real /home/user default is ignored once the variable points elsewhere.
    const out = execFileSync('bash', ['-c', `source <(sed -n '/^attached_review_texts()/,/^}/p' "${path.join(fx.proj, 'scripts', 'cloud-bootstrap-data.sh')}"); ROOT="${fx.proj}"; attached_review_texts || echo none`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, BSC_ATTACHED_REPOS_DIR: path.join(fx.root, 'nowhere') },
    }).trim();
    assert.equal(out, 'none', 'a missing attached dir finds nothing, never /home/user');
    const found = execFileSync('bash', ['-c', `source <(sed -n '/^attached_review_texts()/,/^}/p' "${path.join(fx.proj, 'scripts', 'cloud-bootstrap-data.sh')}"); ROOT="${fx.proj}"; attached_review_texts`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, BSC_ATTACHED_REPOS_DIR: path.join(fx.root, 'attached') },
    }).trim();
    assert.equal(found, rt);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('BRO-5892: read-only audits default to dry run in a cloud session only', () => {
  const cloud = { CLAUDE_CODE_REMOTE: 'true' };
  assert.equal(cloudAuditDryRun([], cloud).dryRun, true);
  assert.match(cloudAuditDryRun([], cloud).note, /--write/);
  assert.deepEqual(cloudAuditDryRun(['--write'], cloud), { dryRun: false, note: null });
  assert.deepEqual(cloudAuditDryRun([], { ...cloud, GITHUB_ACTIONS: 'true' }), { dryRun: false, note: null });
  assert.deepEqual(cloudAuditDryRun([], {}), { dryRun: false, note: null });
  assert.deepEqual(cloudAuditDryRun(['--dry-run'], {}), { dryRun: true, note: null });
});
