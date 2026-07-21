import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  DATA_REPO_URLS, cloneDataRepo, verifyRebaseData, countPriorMerges, redactSecrets, main, USAGE,
} = require('./autonomous-merge.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Throwaway bare "origin" + working clone, standing in for one of the two
// private repos (broadway-scorecard-data / broadway-review-texts) that
// scripts/autonomous-merge.js's Tier-2 path (S4-T4) clones via a REAL
// GitHub URL in production. Tests never touch the real repos — cloneDataRepo
// itself is only exercised for its unknown-repoKey error path below; the
// rebase/gate/verify plumbing is exercised directly against this fixture.
function makeFixtureRepo(seedFiles) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-merge-data-fixture-'));
  const bare = path.join(tmp, 'origin.git');
  const clone = path.join(tmp, 'clone');
  git(tmp, ['init', '--bare', '-b', 'main', bare]);
  git(tmp, ['clone', bare, clone]);
  git(clone, ['config', 'user.email', 'test@example.com']);
  git(clone, ['config', 'user.name', 'Test']);
  for (const [rel, content] of Object.entries(seedFiles)) {
    const full = path.join(clone, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'seed']);
  git(clone, ['push', 'origin', 'main']);
  return { tmp, bare, clone };
}

test('DATA_REPO_URLS covers exactly the two Tier-2 repoKeys', () => {
  assert.deepEqual(Object.keys(DATA_REPO_URLS).sort(), ['review-texts', 'scorecard-data']);
  assert.match(DATA_REPO_URLS['scorecard-data'], /broadway-scorecard-data\.git$/);
  assert.match(DATA_REPO_URLS['review-texts'], /broadway-review-texts\.git$/);
});

test('cloneDataRepo refuses an unknown repoKey before touching the network', () => {
  assert.throws(() => cloneDataRepo('nonsense', 'fake-token'), /unknown repoKey/);
});

test('verifyRebaseData: missing-show class rebases, gates, and runs validate-show-venue against the candidate branch', () => {
  const { clone } = makeFixtureRepo({ 'shows.json': '[]' });
  git(clone, ['checkout', '-b', 'auto/fixture-missing-show']);
  fs.writeFileSync(path.join(clone, 'shows.json'), '[{"id":"fixture-2026","provisional":false}]');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'add fixture show']);

  const result = verifyRebaseData(clone, 'scorecard-data', 'missing-show', { showIds: [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.files, ['shows.json']);
});

test('verifyRebaseData: refuses a diff touching a path outside the repoKey allow-list, before running any verifier', () => {
  const { clone } = makeFixtureRepo({ 'shows.json': '[]' });
  git(clone, ['checkout', '-b', 'auto/fixture-bad-path']);
  fs.writeFileSync(path.join(clone, 'junk.json'), '{}');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'sneak in a disallowed file']);

  const result = verifyRebaseData(clone, 'scorecard-data', 'missing-show', {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /ineligible paths/);
  assert.match(result.reason, /junk\.json/);
});

test('verifyRebaseData: refuses when the branch cannot rebase cleanly onto origin/main', () => {
  const { clone } = makeFixtureRepo({ 'shows.json': '[{"id":"a"}]' });
  git(clone, ['checkout', '-b', 'auto/fixture-conflict']);
  fs.writeFileSync(path.join(clone, 'shows.json'), '[{"id":"a-from-branch"}]');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'branch edit']);

  // Advance origin/main with a CONFLICTING edit to the same line.
  git(clone, ['checkout', 'main']);
  fs.writeFileSync(path.join(clone, 'shows.json'), '[{"id":"a-from-main"}]');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'main advances']);
  git(clone, ['push', 'origin', 'main']);
  git(clone, ['checkout', 'auto/fixture-conflict']);

  const result = verifyRebaseData(clone, 'scorecard-data', 'missing-show', {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /would not rebase cleanly/);
  // Must leave the repo in a clean, non-rebasing state for the caller's next
  // retry attempt (verifyRebaseData aborts internally on rebase failure).
  assert.doesNotThrow(() => git(clone, ['status', '--porcelain']));
});

test('verifyRebaseData: review-texts class runs one verify-review-recovery --pre-merge per touched show', () => {
  // assignedScore is required — a live-fire dispatch (2026-07-14) found
  // verify-review-recovery.js Step 4 (LLM scoring) fails any fixture that has
  // content but no score, which made an earlier version of this test flake
  // between {ok:true} and {ok:false} depending on unrelated live-repo state.
  // With a score present, steps 1-4 are deterministic file-level checks (no
  // network, no live reviews.json dependency) so this asserts a fixed PASS.
  const { clone } = makeFixtureRepo({
    'hamilton-2015/nytg--fixture.json': JSON.stringify({ showId: 'hamilton-2015', assignedScore: 75, contentTier: 'complete', fullText: 'x'.repeat(200) }),
  });
  git(clone, ['checkout', '-b', 'auto/fixture-byline-recovery']);
  fs.writeFileSync(path.join(clone, 'hamilton-2015/nytg--fixture.json'), JSON.stringify({ showId: 'hamilton-2015', criticName: 'Fixture Critic', assignedScore: 75, contentTier: 'complete', fullText: 'x'.repeat(200) }));
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'byline recovery fixture edit']);

  const result = verifyRebaseData(clone, 'review-texts', 'byline-recovery', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.showIds, ['hamilton-2015']);
});

test('redactSecrets strips a live REVIEW_TEXTS_TOKEN out of any error text before it can reach a log or Notion note', () => {
  const prior = process.env.REVIEW_TEXTS_TOKEN;
  process.env.REVIEW_TEXTS_TOKEN = 'ghp_supersecrettoken123';
  try {
    const msg = 'Command failed: git clone https://x-access-token:ghp_supersecrettoken123@github.com/thomaspryor/broadway-review-texts.git /tmp/x';
    const redacted = redactSecrets(msg);
    assert.ok(!redacted.includes('ghp_supersecrettoken123'));
    assert.match(redacted, /\*\*\*REDACTED\*\*\*/);
  } finally {
    if (prior === undefined) delete process.env.REVIEW_TEXTS_TOKEN;
    else process.env.REVIEW_TEXTS_TOKEN = prior;
  }
});

test('redactSecrets is a no-op when REVIEW_TEXTS_TOKEN is unset (never throws on a missing env var)', () => {
  const prior = process.env.REVIEW_TEXTS_TOKEN;
  delete process.env.REVIEW_TEXTS_TOKEN;
  try {
    assert.equal(redactSecrets('plain error text'), 'plain error text');
    assert.equal(redactSecrets(null), '');
  } finally {
    if (prior !== undefined) process.env.REVIEW_TEXTS_TOKEN = prior;
  }
});

test('countPriorMerges scopes the oscillation grep to the given cwd, not the main repo', () => {
  const { clone } = makeFixtureRepo({ 'shows.json': '[]' });
  assert.equal(countPriorMerges('some-card-id', clone), 0);

  git(clone, ['commit', '--allow-empty', '-m', 'work\n\nAuto-merge-card: some-card-id']);
  git(clone, ['push', 'origin', 'main']);
  assert.equal(countPriorMerges('some-card-id', clone), 1);
  // A different card id must not match.
  assert.equal(countPriorMerges('other-card-id', clone), 0);
});

test('USAGE documents --card, --branch, --action, and --help', () => {
  assert.match(USAGE, /--card/);
  assert.match(USAGE, /--branch/);
  assert.match(USAGE, /--action/);
  assert.match(USAGE, /--help, -h/);
});

// Same incident class as the 2026-07-14 bsc-conductor bug and the
// 2026-07-20 autonomous-run.js/autonomous-probe.js cousin fix (task #260):
// --help must never fall through to approve()/revert(), which call real
// `gh`/`git` subprocesses (PR merge, revert, push to main). approveFn/revertFn
// are stubbed to THROW so this proves zero calls happen, not just that the
// guard exists somewhere in the source.
test('--help / -h / combined-with-action exit before approve or revert is called', () => {
  const approveFn = () => { throw new Error('approve must not be called for --help'); };
  const revertFn = () => { throw new Error('revert must not be called for --help'); };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.doesNotThrow(() => main(['--help'], approveFn, revertFn));
    assert.doesNotThrow(() => main(['-h'], approveFn, revertFn));
    // The actual reported risk: --help combined with a real action flag.
    assert.doesNotThrow(() => main(['--card', 'abc123', '--branch', 'auto/foo', '--action', 'approve', '--help'], approveFn, revertFn));
    assert.doesNotThrow(() => main(['--card', 'abc123', '--branch', 'auto/foo', '--action', 'revert', '--help'], approveFn, revertFn));
    assert.doesNotThrow(() => main(['--card', 'abc123', '--branch', 'auto/foo', '--action', 'approve', '--help=1'], approveFn, revertFn));
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 5);
  for (const line of logged) assert.match(line, /autonomous-merge\.js — CI-side merge\/revert executor/);
});

test('without --help, a real action routes to the matching approveFn/revertFn', () => {
  const calls = [];
  const approveFn = (cardId, branch) => calls.push(['approve', cardId, branch]);
  const revertFn = (cardId, branch) => calls.push(['revert', cardId, branch]);
  main(['--card', 'abc123', '--branch', 'auto/foo', '--action', 'approve'], approveFn, revertFn);
  main(['--card', 'abc123', '--branch', 'auto/foo', '--action', 'revert'], approveFn, revertFn);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['approve', 'abc123', 'auto/foo']);
  assert.deepEqual(calls[1], ['revert', 'abc123', 'auto/foo']);
});

// Belt-and-suspenders: run the real CLI as a subprocess with `gh` and `git`
// stubbed on PATH to record any invocation and exit nonzero. If the --help
// guard were ever removed or moved after the action routing, `--action
// approve --help` would reach approve()'s git fetch/gh calls and the stub
// marker file would appear.
function withStubbedBins(names, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-merge-help-'));
  const marker = path.join(tmp, 'spawned.txt');
  for (const bin of names) {
    const binPath = path.join(tmp, bin);
    fs.writeFileSync(binPath, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 1\n`);
    fs.chmodSync(binPath, 0o755);
  }
  try {
    fn({ tmp, marker });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('node scripts/autonomous-merge.js --help never spawns gh or git (real process, PATH-stubbed)', () => {
  withStubbedBins(['gh', 'git'], ({ tmp, marker }) => {
    const script = new URL('./autonomous-merge.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--help'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'gh/git stub must never be invoked for --help');
  });
});

test('node scripts/autonomous-merge.js --action approve --help never spawns gh or git (real process)', () => {
  withStubbedBins(['gh', 'git'], ({ tmp, marker }) => {
    const script = new URL('./autonomous-merge.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [
      script, '--card', 'abc123', '--branch', 'auto/foo', '--action', 'approve', '--help',
    ], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'gh/git stub must never be invoked for --action approve --help');
  });
});
