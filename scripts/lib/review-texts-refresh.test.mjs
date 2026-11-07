// BRO-5400: cloud-bootstrap-data.sh copied data/review-texts only when it was empty,
// so a stale copy from an earlier session was never replaced. Unit tests drive the
// real decision function (CLAUDE.md §15); the end-to-end test runs the real
// cloud-bootstrap-data.sh + setup-local-data.sh in a throwaway project + fake HOME
// against a fixture "attached" clone, never the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LIB = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(LIB, '..');
const { decideRefresh, copyFacts, sourceSha, staleWarning } = require('./review-texts-refresh.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const roots = new Set();
const removeRoots = () => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ } } };
process.on('exit', removeRoots);
const tmp = (p) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.add(r); return r; };

const base = { present: true, isLink: false, isCheckout: false, copySha: 'aaa111', wantSha: 'bbb222' };

test('decideRefresh: re-copies a stale or unstamped copy at startup/resume, keeps everything else', () => {
  assert.equal(decideRefresh(base).action, 'copy', 'stale copy at startup');
  assert.equal(decideRefresh({ ...base, event: 'resume' }).action, 'copy', 'stale copy at resume');
  assert.equal(decideRefresh({ ...base, copySha: '' }).action, 'copy', 'unstamped copy');
  assert.equal(decideRefresh({ ...base, copySha: 'unknown' }).action, 'copy', 'stamp "unknown"');
  assert.equal(decideRefresh({ ...base, present: false }).action, 'copy', 'empty');
  assert.equal(decideRefresh({ ...base, copySha: 'bbb222' }).action, 'keep', 'current');
  assert.equal(decideRefresh({ ...base, event: 'compact' }).action, 'keep', 'compact keeps the session copy');
  assert.equal(decideRefresh({ ...base, event: 'clear' }).action, 'keep', 'clear keeps the session copy');
  assert.equal(decideRefresh({ ...base, isLink: true }).action, 'keep', 'worktree link');
  assert.equal(decideRefresh({ ...base, isCheckout: true }).action, 'keep', 'a real checkout is never copied over');
  assert.equal(decideRefresh({ ...base, wantSha: '' }).action, 'keep', 'unreadable clone: never re-copy blind');
});

test('sourceSha matches what setup-local-data.sh copies: origin/main over HEAD', () => {
  const root = tmp('rt-sha-');
  const up = path.join(root, 'up');
  fs.mkdirSync(up);
  git(up, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(up, 'a.json'), '1');
  git(up, 'add', '.'); git(up, 'commit', '-qm', 'one');
  const clone = path.join(root, 'clone');
  git(root, 'clone', '-q', up, clone);
  const main = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'checkout', '-qb', 'work');
  fs.writeFileSync(path.join(clone, 'b.json'), '2');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'local');
  assert.notEqual(git(clone, 'rev-parse', 'HEAD'), main);
  assert.equal(sourceSha(clone), main, 'a working branch in the clone must not trigger a re-copy every start');
  assert.equal(sourceSha(path.join(root, 'nope')), '');
});

test('staleWarning: one line for a stale copy, nothing for a current copy, a link or a checkout', () => {
  assert.match(staleWarning(base, 'bbb222'), /STALE review texts.*aaa111.*bbb222/);
  assert.match(staleWarning({ ...base, copySha: '' }, 'bbb222'), /unstamped/);
  assert.equal(staleWarning({ ...base, copySha: 'bbb222' }, 'bbb222'), '');
  assert.equal(staleWarning({ ...base, isLink: true }, 'bbb222'), '');
  assert.equal(staleWarning({ ...base, isCheckout: true }, 'bbb222'), '');
  assert.equal(staleWarning({ ...base, present: false }, 'bbb222'), '');
});

// ---- end to end: the real bootstrap against a fixture clone ----
const SHOW_COUNT = 1001; // setup-local-data.sh refuses to swap in a copy with < 1000 json files

function fixture() {
  const root = tmp('bro-5400-');
  const home = path.join(root, 'home');
  const core = path.join(home, 'broadway-scorecard-data');
  fs.mkdirSync(core, { recursive: true });
  git(core, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(core, 'shows.json'), JSON.stringify({ shows: [] }));
  fs.writeFileSync(path.join(core, 'reviews.json'), '[]');
  git(core, 'add', '.'); git(core, 'commit', '-qm', 'seed');

  const rt = path.join(root, 'attached', 'broadway-review-texts');
  fs.mkdirSync(rt, { recursive: true });
  git(rt, 'init', '-q', '-b', 'main');
  for (let i = 0; i < SHOW_COUNT; i++) {
    const d = path.join(rt, `show-${i}`);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'nyt--critic.json'), '{"v":1}');
  }
  git(rt, 'add', '.'); git(rt, 'commit', '-qm', 'v1');

  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'data'));
  for (const f of ['setup-local-data.sh', 'cloud-bootstrap-data.sh', 'lib/core-data-clone-guard.sh',
    'lib/link-review-texts-clone.sh', 'lib/is-partial-clone.sh', 'lib/review-texts-refresh.js']) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(proj, 'scripts', f));
  }
  return { root, home, rt, proj, data: path.join(proj, 'data') };
}

function bootstrap(fx, event = 'startup') {
  return execFileSync('bash', [path.join(fx.proj, 'scripts', 'cloud-bootstrap-data.sh')], {
    cwd: fx.proj, encoding: 'utf8', stdio: 'pipe', timeout: 120000,
    env: { PATH: process.env.PATH, HOME: fx.home, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_REMOTE: 'true',
      BSC_ATTACHED_REPOS_DIR: path.join(fx.root, 'attached'), BSC_SESSION_EVENT: event },
  });
}

test('bootstrap replaces a stale non-empty review-texts copy at startup, not on compact', () => {
  const fx = fixture();
  const v1 = git(fx.rt, 'rev-parse', 'HEAD');
  const file = path.join(fx.data, 'review-texts', 'show-0', 'nyt--critic.json');

  let out = bootstrap(fx);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}', `first copy:\n${out}`);
  assert.equal(copyFacts(path.join(fx.data, 'review-texts')).copySha, v1);

  // The clone moves on (re-homed file, new content): the old empty-only rule kept the stale copy.
  fs.writeFileSync(path.join(fx.rt, 'show-0', 'nyt--critic.json'), '{"v":2}');
  fs.renameSync(path.join(fx.rt, 'show-1'), path.join(fx.rt, 'show-1-moved'));
  git(fx.rt, 'add', '-A'); git(fx.rt, 'commit', '-qm', 'v2');
  const v2 = git(fx.rt, 'rev-parse', 'HEAD');

  out = bootstrap(fx, 'compact');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}', 'compact keeps the session copy');
  assert.match(out, /STALE review texts/, `compact still says the copy is stale:\n${out}`);

  // Leftover from a copy an earlier start's timeout killed mid-way.
  const leftover = path.join(fx.data, '.review-texts.new.99999');
  fs.mkdirSync(path.join(leftover, 'show-x'), { recursive: true });

  out = bootstrap(fx, 'startup');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}', `startup re-copies:\n${out}`);
  assert.equal(fs.existsSync(leftover), false, 'a killed copy\'s half-built tree is removed');
  assert.equal(fs.existsSync(path.join(fx.data, 'review-texts', 'show-1')), false, 'files the clone moved are gone');
  assert.equal(copyFacts(path.join(fx.data, 'review-texts')).copySha, v2);
  assert.doesNotMatch(out, /STALE review texts/);

  // Current copy: no re-copy on the next start.
  out = bootstrap(fx, 'startup');
  assert.doesNotMatch(out, /copying review texts/, `a current copy is kept:\n${out}`);
  assert.equal(execFileSync('git', ['-C', fx.rt, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'clone untouched');
});
