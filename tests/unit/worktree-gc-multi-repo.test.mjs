// BRO-2540: gc-merged-worktrees.sh hardcoded a single `REPO=` constant and
// only ever GC'd the web repo. ~/BroadwayScorecard-app/.claude/worktrees was
// never touched by anything and grew to 51GB across 34 worktrees — 34GB of
// it pure, gitignored Xcode build output (`ios/build`) — which is why disk
// hit a 5.0Gi free floor on 2026-08-30 even while the web-repo GC ran hourly
// and reported success every run.
//
// Exercises the REAL functions from scripts/lib/worktree-gc-repos.js
// (CLAUDE.md rule 15) — no reimplementation of repo-set or build-artifact
// classification logic here.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { getGcRepos, isReclaimableBuildDir, isValidRepoEntry, DEFAULT_REPOS } from '../../scripts/lib/worktree-gc-repos.js';

test('repo set is data-driven: more than one repo, not a single hardcoded constant', () => {
  const repos = getGcRepos();
  assert.ok(Array.isArray(repos), 'getGcRepos() must return an array');
  assert.ok(repos.length > 1, 'a single-repo constant would fail this — the whole point of BRO-2540 is covering more than one repo');
});

test('repo set includes the iOS app repo (BroadwayScorecard-app)', () => {
  const repos = getGcRepos();
  const ios = repos.find((r) => r.path === path.join(os.homedir(), 'BroadwayScorecard-app'));
  assert.ok(ios, 'BroadwayScorecard-app must be in the default repo set — this is the whole point of BRO-2540');
  assert.ok(Array.isArray(ios.buildArtifactDirs) && ios.buildArtifactDirs.length > 0, 'iOS repo must declare reclaimable build-artifact dirs');
  assert.ok(ios.buildArtifactDirs.includes('ios/build'), 'ios/build is the 34GB stale build-output dir named in BRO-2540');
});

test('repo set is genuinely data-driven: WORKTREE_GC_REPOS_JSON overrides the default set at call time', () => {
  const before = process.env.WORKTREE_GC_REPOS_JSON;
  try {
    const overrideRepos = [
      { name: 'test-only', path: '/tmp/does-not-matter', worktreeDir: '.claude/worktrees', buildArtifactDirs: ['scratch'] },
    ];
    process.env.WORKTREE_GC_REPOS_JSON = JSON.stringify(overrideRepos);
    const repos = getGcRepos();
    assert.deepEqual(repos, overrideRepos, 'a hardcoded constant could never be swapped out at call time like this');
  } finally {
    if (before === undefined) delete process.env.WORKTREE_GC_REPOS_JSON;
    else process.env.WORKTREE_GC_REPOS_JSON = before;
  }
});

test('a malformed WORKTREE_GC_REPOS_JSON override falls back to the defaults, never an empty/no-op repo set', () => {
  const before = process.env.WORKTREE_GC_REPOS_JSON;
  try {
    process.env.WORKTREE_GC_REPOS_JSON = '{not valid json';
    const repos = getGcRepos();
    assert.deepEqual(repos, DEFAULT_REPOS);
  } finally {
    if (before === undefined) delete process.env.WORKTREE_GC_REPOS_JSON;
    else process.env.WORKTREE_GC_REPOS_JSON = before;
  }
});

test('isReclaimableBuildDir: a stale, gitignored build-output directory is classified reclaimable', () => {
  const result = isReclaimableBuildDir({
    exists: true,
    isGitIgnored: true,
    daysSinceModified: 7,
    staleDays: 3,
  });
  assert.equal(result, true, 'ios/build sitting untouched for 7 days (>3 day staleness gate), gitignored, must be reclaimable');
});

test('isReclaimableBuildDir: a recently-touched build dir is NOT reclaimable, even if gitignored', () => {
  const result = isReclaimableBuildDir({
    exists: true,
    isGitIgnored: true,
    daysSinceModified: 1,
    staleDays: 3,
  });
  assert.equal(result, false, 'an active build in progress must not be stripped out from under it');
});

test('isReclaimableBuildDir: a tracked (not gitignored) directory is never reclaimable, however stale', () => {
  const result = isReclaimableBuildDir({
    exists: true,
    isGitIgnored: false,
    daysSinceModified: 30,
    staleDays: 3,
  });
  assert.equal(result, false, 'reclaiming a tracked directory would destroy committed work, not regenerable output');
});

test('WORKTREE_GC_REPOS_JSON with a path-traversal buildArtifactDirs entry is rejected, falls back to defaults', () => {
  const before = process.env.WORKTREE_GC_REPOS_JSON;
  try {
    process.env.WORKTREE_GC_REPOS_JSON = JSON.stringify([
      { name: 'evil', path: '/tmp/evil', worktreeDir: '.claude/worktrees', buildArtifactDirs: ['../../../important'] },
    ]);
    const repos = getGcRepos();
    assert.deepEqual(repos, DEFAULT_REPOS, 'a `../` buildArtifactDirs entry must never reach the bash rm -rf path — reject the whole override');
  } finally {
    if (before === undefined) delete process.env.WORKTREE_GC_REPOS_JSON;
    else process.env.WORKTREE_GC_REPOS_JSON = before;
  }
});

test('WORKTREE_GC_REPOS_JSON with a comma embedded in a dir name is rejected (would corrupt the CSV wire format)', () => {
  const before = process.env.WORKTREE_GC_REPOS_JSON;
  try {
    process.env.WORKTREE_GC_REPOS_JSON = JSON.stringify([
      { name: 'evil', path: '/tmp/evil', worktreeDir: '.claude/worktrees', buildArtifactDirs: ['build,../escape'] },
    ]);
    const repos = getGcRepos();
    assert.deepEqual(repos, DEFAULT_REPOS);
  } finally {
    if (before === undefined) delete process.env.WORKTREE_GC_REPOS_JSON;
    else process.env.WORKTREE_GC_REPOS_JSON = before;
  }
});

test('isValidRepoEntry: rejects an absolute-looking worktreeDir', () => {
  assert.equal(
    isValidRepoEntry({ name: 'x', path: '/tmp/x', worktreeDir: '/etc', buildArtifactDirs: [] }),
    false,
  );
});

test('isValidRepoEntry: accepts the real default entries', () => {
  for (const r of DEFAULT_REPOS) {
    assert.equal(isValidRepoEntry(r), true, `default entry ${r.name} must itself be valid`);
  }
});

test('isReclaimableBuildDir: a directory that does not exist is never reclaimable', () => {
  const result = isReclaimableBuildDir({
    exists: false,
    isGitIgnored: true,
    daysSinceModified: 30,
    staleDays: 3,
  });
  assert.equal(result, false);
});
