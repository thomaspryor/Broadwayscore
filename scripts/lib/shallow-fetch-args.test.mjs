import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shallowFetchArgs, repoDepthArgs, DEFAULT_SLACK_SEC, DEFAULT_FALLBACK_DEPTH } = require('./shallow-fetch-args.js');

const EPOCH = 1_753_500_000; // fixed; no wall-clock in assertions

test('complete clone gets NO depth bound (never shallow-ify a full checkout)', () => {
  assert.deepEqual(shallowFetchArgs({ isShallow: false, oldestCommitEpoch: EPOCH }), []);
});

test('shallow clone gets --shallow-since anchored slack-seconds before the boundary commit', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH, slackSec: 1800 }),
    [`--shallow-since=@${EPOCH - 1800}`]
  );
});

test('default slack is applied when none is passed', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH }),
    [`--shallow-since=@${EPOCH - DEFAULT_SLACK_SEC}`]
  );
});

test('epoch may arrive as a string (git log output is text)', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: String(EPOCH), slackSec: 60 }),
    [`--shallow-since=@${EPOCH - 60}`]
  );
});

test('unusable epoch falls back to a relative deepen — bounded, and never SHORTENS history', () => {
  for (const bad of ['', undefined, null, 'not-a-number', 0, -5, NaN]) {
    assert.deepEqual(
      shallowFetchArgs({ isShallow: true, oldestCommitEpoch: bad }),
      [`--deepen=${DEFAULT_FALLBACK_DEPTH}`],
      `epoch ${JSON.stringify(bad)} should fall back to a relative deepen`
    );
  }
});

test('THE REGRESSION: a shallow repo must never receive an empty arg list', () => {
  // An empty list means push-with-retry.sh issues an unbounded fetch, which is
  // exactly the task-#466 pathology: upload-pack answers a shallow client with
  // the entire 165k-commit / ~2.1 GB history and the fetch dies at rc=124 on
  // every retry. Measured 2026-07-26: bare AND explicit-refspec forms both hit
  // a 300 s wall; --depth-bounded finished in 8 s.
  for (const epoch of [EPOCH, String(EPOCH), '', null]) {
    const args = shallowFetchArgs({ isShallow: true, oldestCommitEpoch: epoch });
    assert.ok(args.length > 0, `shallow repo with epoch ${JSON.stringify(epoch)} got an unbounded fetch`);
  }
});

test('since-anchor never goes non-positive even with absurd slack', () => {
  const [arg] = shallowFetchArgs({ isShallow: true, oldestCommitEpoch: 10, slackSec: 10_000 });
  assert.equal(arg, '--shallow-since=@1');
});

test('negative or non-numeric slack is treated as zero, not NaN', () => {
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH, slackSec: -100 }),
    [`--shallow-since=@${EPOCH}`]
  );
  assert.deepEqual(
    shallowFetchArgs({ isShallow: true, oldestCommitEpoch: EPOCH, slackSec: 'abc' }),
    [`--shallow-since=@${EPOCH}`]
  );
});

test('emitted args contain no whitespace (the shell word-splits them)', () => {
  const cases = [
    { isShallow: true, oldestCommitEpoch: EPOCH },
    { isShallow: true, oldestCommitEpoch: '' },
  ];
  for (const c of cases) {
    for (const arg of shallowFetchArgs(c)) {
      assert.ok(!/\s/.test(arg), `arg ${JSON.stringify(arg)} contains whitespace`);
    }
  }
});

test('no-argument call is safe (treated as a complete clone)', () => {
  assert.deepEqual(shallowFetchArgs(), []);
});

// ── repoDepthArgs: the git-shelling derivation that feeds shallowFetchArgs ──
//
// This half was untested for its entire life as an inline copy inside
// autofix-canary.js's markerExistsOnOriginMain (never exported, never reached
// by that file's tests). Extracting it made it testable, so test it — and in
// particular test the isShallow=true path, which is the ONLY reason the
// derivation exists and the one a full-clone fixture can never reach.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function makeRepoWithTwoCommits() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-depth-args-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  const git = (...a) => execFileSync('git', a, { cwd: seed, encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // Two commits: --depth=1 needs history to actually truncate.
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  fs.writeFileSync(path.join(seed, 'b.txt'), 'two\n');
  git('add', '-A');
  git('commit', '-qm', 'second');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  return { root, origin };
}

test('repoDepthArgs on a SHALLOW clone returns a --shallow-since bound (the branch that never had coverage)', () => {
  const { root, origin } = makeRepoWithTwoCommits();
  const shallow = path.join(root, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${origin}`, shallow]);
  assert.equal(
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: shallow, encoding: 'utf8' }).trim(),
    'true',
    'fixture precondition: the clone must actually be shallow'
  );

  const args = repoDepthArgs({ repoRoot: shallow });
  assert.equal(args.length, 1, `expected exactly one bound arg, got ${JSON.stringify(args)}`);
  assert.match(args[0], /^--shallow-since=@\d+$/, args[0]);
  // The bound must be derived from the clone's own oldest commit, not a
  // constant — an unanchored bound is what task #466 was about.
  const epoch = Number(args[0].replace('--shallow-since=@', ''));
  const oldest = Number(
    execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { cwd: shallow, encoding: 'utf8' }).trim()
  );
  assert.ok(
    epoch <= oldest && epoch > oldest - 86_400,
    `bound ${epoch} should sit just below the boundary commit ${oldest}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('repoDepthArgs on a COMPLETE clone returns no bound (never shallow-ify a full checkout)', () => {
  const { root, origin } = makeRepoWithTwoCommits();
  const full = path.join(root, 'full');
  execFileSync('git', ['clone', '-q', `file://${origin}`, full]);
  assert.deepEqual(repoDepthArgs({ repoRoot: full }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repoDepthArgs fails open to [] when the path is not a git repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-depth-args-nogit-'));
  assert.deepEqual(repoDepthArgs({ repoRoot: tmp }), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
