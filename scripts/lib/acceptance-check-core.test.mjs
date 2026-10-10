import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { runVerify, zeroPassingTests } = require('./acceptance-check-core.js');

function tmpCheckout() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-check-core-test-'));
}

// BRO-3446: --allow-phantom-path (or a since-renamed/deleted file) can freeze
// an acceptance command naming a path that was never created. isSafeCheckCommand
// only validates shape, so the command reaches runVerify, node exits non-zero
// on the missing module, and the pre-fix behaviour reported `fail` — read by
// the nightly recheck as "this card's fix no longer works" for a card whose
// fix is correct and live. This must report `unverifiable` instead.
test('BRO-3446: a command naming a path absent from the checkout is unverifiable, not fail', () => {
  const cwd = tmpCheckout();
  try {
    const out = runVerify(cwd, 'node --test tests/unit/does-not-exist.test.mjs', { attempts: 1 });
    assert.equal(out.status, 'unverifiable');
    assert.match(out.detail, /tests\/unit\/does-not-exist\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3446: the guard does not mask a real failure once the path exists', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/broken.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => { assert.equal(1, 2); });\n",
    );
    const out = runVerify(cwd, 'node --test tests/unit/broken.test.mjs', { attempts: 1 });
    assert.equal(out.status, 'fail');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3446: a command whose path DOES exist still runs and can pass', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/ok.test.mjs'),
      "import test from 'node:test';\ntest('ok', () => {});\n",
    );
    const out = runVerify(cwd, 'node --test tests/unit/ok.test.mjs', { attempts: 1 });
    assert.equal(out.status, 'pass');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// BRO-4523: a test file whose every test skips exits 0 and proved nothing.
test('BRO-4523: a test file whose tests all skip is unverifiable, not pass', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/skipped.test.mjs'),
      "import test from 'node:test';\ntest('needs a key', { skip: 'no key' }, () => {});\n",
    );
    const out = runVerify(cwd, 'node --test tests/unit/skipped.test.mjs', { attempts: 1 });
    assert.equal(out.status, 'unverifiable');
    assert.match(out.detail, /no passing tests/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-4523: zeroPassingTests reads the last summary line, either reporter', () => {
  assert.equal(zeroPassingTests('# tests 1\n# pass 0\n# skipped 1\n'), true);
  assert.equal(zeroPassingTests('ℹ tests 2\nℹ pass 0\nℹ skipped 2\n'), true);
  assert.equal(zeroPassingTests('# tests 3\n# pass 3\n'), false);
  assert.equal(zeroPassingTests('# Subtest: x\n# pass 0\n# pass 4\n'), false);
  // no summary at all (custom reporter, non-node command): never downgraded
  assert.equal(zeroPassingTests('all good\n'), false);
  assert.equal(zeroPassingTests(''), false);
});

// BRO-4241: the shallow clone's "can't deepen" failure falls back to a
// standalone clone; BRO-4956: so does a lock still held after the backoff.
// Timeouts and pinned shas fail as before.
test('shouldCloneAfterFetchFailure: unshallow or lock contention, never pinned or timed out', () => {
  const { shouldCloneAfterFetchFailure } = require('./acceptance-check-core.js');
  const unshallow = Object.assign(new Error('Command failed: git fetch --deepen=200 origin main'), { stderr: Buffer.from('fatal: error in object: unshallow 3d8ddac0cc42d7f7e400eafe9bc0405097075768\n') });
  assert.equal(shouldCloneAfterFetchFailure(unshallow, null), true);
  assert.equal(shouldCloneAfterFetchFailure(unshallow, 'abc123'), false);
  const timedOut = Object.assign(new Error('spawnSync git ETIMEDOUT'), { signal: 'SIGTERM', stderr: Buffer.from('unshallow') });
  assert.equal(shouldCloneAfterFetchFailure(timedOut, null), false);
  const lock = Object.assign(new Error('Command failed'), { stderr: Buffer.from("fatal: Unable to create '/x/.git/shallow.lock': File exists.") });
  assert.equal(shouldCloneAfterFetchFailure(lock, null), true);
  assert.equal(shouldCloneAfterFetchFailure(lock, 'abc123'), false);
  const refLock = Object.assign(new Error('Command failed'), { stderr: Buffer.from("error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/x/.git/refs/remotes/origin/main.lock': File exists.") });
  assert.equal(shouldCloneAfterFetchFailure(refLock, null), true);
  const offline = Object.assign(new Error('Command failed'), { stderr: Buffer.from('fatal: unable to access: Could not resolve host: github.com') });
  assert.equal(shouldCloneAfterFetchFailure(offline, null), false);
  assert.equal(shouldCloneAfterFetchFailure(null, null), false);
});

// BRO-4830: the Done gate copies core data out of the local data clone; a
// stale clone made correct cards fail on old data. Fixture: bare origin +
// data clone (symlinked into a code repo's data/) so the real helpers run.
const { makeFreshCheckout, removeCheckout } = require('./acceptance-check-core.js');
const { refreshDataClone, decideRefresh } = require('./data-clone-refresh.js');
import { execFileSync } from 'node:child_process';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4830-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const dataClone = path.join(root, 'data-clone');
  const codeOrigin = path.join(root, 'code-origin.git');
  const repo = path.join(root, 'repo');
  sh(root, 'init', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'shows.json'), '{"v":1}');
  sh(seed, 'add', '.'); sh(seed, ...GIT_ID, 'commit', '-m', 'v1');
  sh(seed, 'push', origin, 'main');
  sh(root, 'clone', origin, dataClone);
  // code repo whose data/shows.json symlinks into the data clone
  sh(root, 'init', '--bare', '-b', 'main', codeOrigin);
  sh(root, 'init', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'README'), 'x');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'data/\nnode_modules\n');
  sh(repo, 'add', '.'); sh(repo, ...GIT_ID, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', codeOrigin); sh(repo, 'push', 'origin', 'main');
  fs.mkdirSync(path.join(repo, 'data'));
  fs.symlinkSync(path.join(dataClone, 'shows.json'), path.join(repo, 'data', 'shows.json'));
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const advance = (v) => {
    fs.writeFileSync(path.join(seed, 'shows.json'), `{"v":${v}}`);
    sh(seed, ...GIT_ID, 'commit', '-am', `v${v}`); sh(seed, 'push', origin, 'main');
  };
  return { root, repo, dataClone, advance };
}

function copiedShows(co) { return fs.readFileSync(path.join(co.wt, 'data', 'shows.json'), 'utf8'); }

test('BRO-4830: stale-but-clean data clone is fast-forwarded BEFORE the copy', () => {
  const f = fixture();
  try {
    f.advance(2);
    const co = makeFreshCheckout({ repo: f.repo, prefix: 'bro4830-co-' });
    try {
      assert.equal(copiedShows(co), '{"v":2}');
      assert.equal(co.dataClone.status, 'fast-forwarded');
      assert.equal(co.prepared, true);
    } finally { removeCheckout(co); }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('BRO-4830: a stale DIRTY data clone is untouched and the checkout is unverifiable, never fail', () => {
  const f = fixture();
  try {
    f.advance(2);
    fs.writeFileSync(path.join(f.dataClone, 'shows.json'), '{"v":"local-edit"}');
    const co = makeFreshCheckout({ repo: f.repo, prefix: 'bro4830-co-' });
    try {
      assert.equal(co.dataClone.status, 'unsafe');
      assert.equal(co.prepared, false);
      assert.equal(fs.readFileSync(path.join(f.dataClone, 'shows.json'), 'utf8'), '{"v":"local-edit"}');
      const out = runVerify(co.wt, 'node --test tests/unit/x.test.mjs', { attempts: 1, prepared: co.prepared });
      assert.equal(out.status, 'unverifiable');
    } finally { removeCheckout(co); }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('BRO-4830: refreshDataClone states: current, diverged=unsafe, missing=skipped, once per process', () => {
  const f = fixture();
  try {
    assert.equal(refreshDataClone(f.repo, { memoize: false }).status, 'current');
    f.advance(2);
    // local commit makes the clone ahead AND behind
    fs.writeFileSync(path.join(f.dataClone, 'local.txt'), 'x');
    sh(f.dataClone, 'add', '.'); sh(f.dataClone, ...GIT_ID, 'commit', '-m', 'local');
    assert.equal(refreshDataClone(f.repo, { memoize: false }).status, 'unsafe');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4830-nodata-'));
    const savedEnv = process.env.BSC_DATA_REPO; delete process.env.BSC_DATA_REPO;
    try { assert.equal(refreshDataClone(bare).status, 'skipped'); } finally { if (savedEnv !== undefined) process.env.BSC_DATA_REPO = savedEnv; }
    fs.rmSync(bare, { recursive: true, force: true });
    // memoized: a second call returns the same object without re-fetching
    const a = refreshDataClone(f.repo); const b = refreshDataClone(f.repo);
    assert.equal(a, b);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('BRO-4830: decideRefresh policy table', () => {
  assert.equal(decideRefresh({ behind: false, headInOrigin: true, originInHead: true, dirty: true }), 'current');
  assert.equal(decideRefresh({ behind: true, headInOrigin: true, originInHead: false, dirty: false }), 'fast-forward');
  assert.equal(decideRefresh({ behind: true, headInOrigin: true, originInHead: false, dirty: true }), 'unsafe');
  assert.equal(decideRefresh({ behind: true, headInOrigin: false, originInHead: false, dirty: false }), 'unsafe');
});

// BRO-4830 prevention: runVerify defaults prepared=true, so a caller that
// takes a makeFreshCheckout() result but omits `prepared` silently grades an
// unprepared (stale-data / no node_modules) checkout as pass/fail. Every
// script that uses both must reference the checkout's `prepared` flag.
test('BRO-4830: every script combining makeFreshCheckout + runVerify passes/gates on prepared', () => {
  const dir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!/\bmakeFreshCheckout\b|\bfreshCheckout\b/.test(src) || !/\brunVerify\(/.test(src)) continue;
    if (!/\.prepared\b|\bprepared[:,]/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test('BRO-4830: ff-only merge failure on a known-behind clone is unsafe, unknown is not memoized', () => {
  const f = fixture();
  try {
    f.advance(2);
    // an untracked file that the incoming commit would create blocks the ff merge
    fs.writeFileSync(path.join(f.dataClone, 'new.json'), 'local');
    const seed = path.join(f.root, 'seed');
    fs.writeFileSync(path.join(seed, 'new.json'), 'remote');
    sh(seed, 'add', '.'); sh(seed, ...GIT_ID, 'commit', '-m', 'add new'); sh(seed, 'push', path.join(f.root, 'origin.git'), 'main');
    const r = refreshDataClone(f.repo, { memoize: false });
    assert.equal(r.status, 'unsafe');
    assert.match(r.detail, /ff-only merge failed/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// BRO-4956: a ref lock held by another fetch in the same clone (cloud board
// workers run two lanes in one repo) must not refuse a Done close. After the
// backoff an unpinned caller gets a standalone clone; a pinned one still throws.
test('BRO-4956: a held fetch lock falls back to a standalone clone, never for a pinned sha', () => {
  const f = fixture();
  try {
    const other = path.join(f.root, 'other');
    sh(f.root, 'clone', sh(f.repo, 'remote', 'get-url', 'origin'), other);
    fs.writeFileSync(path.join(other, 'README'), 'y');
    sh(other, ...GIT_ID, 'commit', '-am', 'advance'); sh(other, 'push', 'origin', 'main');
    const lock = path.join(f.repo, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    fs.writeFileSync(lock, '');
    const co = makeFreshCheckout({ repo: f.repo, prefix: 'bro4956-co-', lockRetryDelaysMs: [0, 0] });
    try {
      assert.equal(co.standalone, true);
      assert.equal(fs.readFileSync(path.join(co.wt, 'README'), 'utf8'), 'y');
    } finally { removeCheckout(co); }
    assert.ok(fs.existsSync(lock), 'the other process\'s lock is never removed');
    const pinned = sh(f.repo, 'rev-parse', 'HEAD');
    assert.throws(() => makeFreshCheckout({ repo: f.repo, prefix: 'bro4956-co-', sha: pinned, lockRetryDelaysMs: [0] }), /\.lock': File exists/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
