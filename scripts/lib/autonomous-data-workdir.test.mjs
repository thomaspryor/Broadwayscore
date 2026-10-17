import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { buildDataWorkdir, removeDataWorkdir, pushDataBranch, showIdsFromReviewTextsDiff, primaryWorktree } = require('./autonomous-data-workdir.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Build a throwaway bare "origin" + a working clone seeded with one commit on
// main, standing in for ~/broadway-scorecard-data or data/review-texts —
// NEVER the real private repos (this sprint's whole point is never touching
// their mains unattended, so tests must not either).
function makeFixtureRepo(seedFiles) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-data-repo-'));
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

test('scorecard-data: builds a worktree + symlink, edits write through, push lands a NEW branch (never main)', () => {
  const { tmp, clone } = makeFixtureRepo({ 'shows.json': '[]' });
  const scratchRoot = path.join(tmp, 'scratch');
  const branch = 'auto/test-fixture-scorecard-data';

  const wd = buildDataWorkdir({ repoKey: 'scorecard-data', branch, scratchRoot, scorecardDataPath: clone });
  try {
    assert.ok(fs.existsSync(path.join(wd.dataDir, 'shows.json')));
    assert.ok(fs.lstatSync(path.join(wd.dataDir, 'shows.json')).isSymbolicLink());

    // Edit through the symlink, as the implementer would.
    fs.writeFileSync(path.join(wd.dataDir, 'shows.json'), '[{"id":"fixture-2026"}]');
    assert.equal(fs.readFileSync(path.join(wd.worktrees.scorecardData.path, 'shows.json'), 'utf8'), '[{"id":"fixture-2026"}]');

    git(wd.worktrees.scorecardData.path, ['add', '-A']);
    git(wd.worktrees.scorecardData.path, ['commit', '-q', '-m', 'fixture change']);
    pushDataBranch(wd.worktrees.scorecardData.path, branch);

    const branches = git(clone, ['ls-remote', '--heads', 'origin']);
    assert.match(branches, new RegExp(branch));
    // main on origin must be untouched — still the seed commit, not the fixture change.
    const mainShows = git(clone, ['show', 'origin/main:shows.json']);
    assert.equal(mainShows.trim(), '[]');
  } finally {
    removeDataWorkdir(wd);
  }
  assert.equal(fs.existsSync(scratchRoot), false);
});

test('review-texts: builds a worktree + symlinked dir (not a single file)', () => {
  const { tmp, clone } = makeFixtureRepo({ 'hamilton-2015/nytg--fixture.json': '{"showId":"hamilton-2015"}' });
  const scratchRoot = path.join(tmp, 'scratch2');
  const branch = 'auto/test-fixture-review-texts';

  const wd = buildDataWorkdir({ repoKey: 'review-texts', branch, scratchRoot, reviewTextsPath: clone });
  try {
    assert.ok(fs.lstatSync(path.join(wd.dataDir, 'review-texts')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(wd.dataDir, 'review-texts', 'hamilton-2015', 'nytg--fixture.json')));
  } finally {
    removeDataWorkdir(wd);
  }
});

test('primaryWorktree returns whichever of scorecardData/reviewTexts was built', () => {
  const { tmp: tmp1, clone: clone1 } = makeFixtureRepo({ 'shows.json': '[]' });
  const wd1 = buildDataWorkdir({ repoKey: 'scorecard-data', branch: 'auto/t1', scratchRoot: path.join(tmp1, 's'), scorecardDataPath: clone1 });
  try { assert.equal(primaryWorktree(wd1), wd1.worktrees.scorecardData); } finally { removeDataWorkdir(wd1); }

  const { tmp: tmp2, clone: clone2 } = makeFixtureRepo({ 'show/x.json': '{}' });
  const wd2 = buildDataWorkdir({ repoKey: 'review-texts', branch: 'auto/t2', scratchRoot: path.join(tmp2, 's'), reviewTextsPath: clone2 });
  try { assert.equal(primaryWorktree(wd2), wd2.worktrees.reviewTexts); } finally { removeDataWorkdir(wd2); }
});

test('buildDataWorkdir refuses an unknown repoKey', () => {
  assert.throws(() => buildDataWorkdir({ repoKey: 'nonsense', branch: 'auto/x', scratchRoot: '/tmp/wont-be-created' }), /unknown repoKey/);
});

test('showIdsFromReviewTextsDiff derives show ids from path shape, including _pending', () => {
  assert.deepEqual(
    showIdsFromReviewTextsDiff([
      'hamilton-2015/nytg--austin-fimmano.json',
      'hamilton-2015/another--critic.json',
      '_pending/kyoto-off-broadway-2025/outlet--critic.json',
    ]).sort(),
    ['hamilton-2015', 'kyoto-off-broadway-2025'].sort()
  );
  assert.deepEqual(showIdsFromReviewTextsDiff([]), []);
  assert.deepEqual(showIdsFromReviewTextsDiff(null), []);
});
