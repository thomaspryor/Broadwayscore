// BRO-4273: check-post-rebase-survival.js false "silently dropped" on a clean
// rebase. Poller run 36511035811 aborted its review-texts push because two
// NEW _pending stubs it added were reported "ABSENT-EVERYWHERE" although the
// rebased commit still created them. Cause: git diff's default rename
// detection paired each new stub with an unrelated _pending stub the remote
// had deleted (promoted) meanwhile — stubs share ~70% of their lines — so the
// file showed as R, not A, and --diff-filter=A dropped it from "actual".
//
// Runs the real CLI against throwaway repos (it is shelled out to by
// push-with-retry.sh, not require()d).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'check-post-rebase-survival.js');
const PUSH_WITH_RETRY = path.join(here, 'push-with-retry.sh');
const REPO = path.join(here, '..', '..');
// Every guard/survival check that lists ADDED files from a diff.
const GUARDED_FILES = [
  SCRIPT,
  PUSH_WITH_RETRY,
  path.join(here, 'push-content-survival.js'),
  path.join(REPO, '.github/actions/check-file-sizes/action.yml'),
  path.join(REPO, 'scripts/data-repo-hooks/pre-commit'),
  path.join(REPO, 'scripts/hooks/pre-commit'),
];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function stub(showId, outlet, url, discoveredAt) {
  return JSON.stringify({
    showId, outlet, outletId: outlet, url, status: 'pending', criticName: null,
    publishDate: null, fullText: null, isFullReview: false, textQuality: 'stub',
    contentTier: 'stub', source: 'opening-night-poller', discoveredAt,
    dtliThumb: null, bwwThumb: null,
  }, null, 2) + '\n';
}

function write(repo, rel, content) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

function newRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'post-rebase-survival-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

function runCheck(repo, beforeSha) {
  return spawnSync('node', [SCRIPT, `--before-sha=${beforeSha}`, '--remote-ref=main'], {
    cwd: repo, encoding: 'utf8',
  });
}

describe('check-post-rebase-survival', () => {
  test('new _pending stub survives a clean rebase over a concurrent stub promotion (run 36511035811)', () => {
    const repo = newRepo();
    write(repo, '_pending/show-a/old--1.json', stub('show-a', 'ew', 'https://ew.com/old-1', '2026-09-28T01:00:00Z'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');

    git(repo, 'checkout', '-qb', 'local');
    write(repo, '_pending/show-b/ew--new.json', stub('show-b', 'ew', 'https://ew.com/new-2', '2026-09-29T03:00:00Z'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'poller: new reviews discovered');

    git(repo, 'checkout', '-q', 'main');
    git(repo, 'rm', '-q', '_pending/show-a/old--1.json');
    git(repo, 'commit', '-qm', 'concurrent run promotes a pending stub');

    git(repo, 'checkout', '-q', 'local');
    const before = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'rebase', '-q', '-X', 'theirs', 'main');
    // Precondition: default rename detection really does pair the two files.
    assert.match(git(repo, 'diff', '--name-status', `${before}~1..HEAD`), /^R\d+\t_pending\/show-a\/old--1\.json\t_pending\/show-b\/ew--new\.json$/m);
    assert.ok(fs.existsSync(path.join(repo, '_pending/show-b/ew--new.json')));

    const r = runCheck(repo, before);
    assert.equal(r.status, 0, `expected OK, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /all 1 added files survived/);
  });

  test('a file the rebase genuinely dropped is still caught', () => {
    const repo = newRepo();
    write(repo, 'README', 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'checkout', '-qb', 'local');
    write(repo, '_pending/show-b/ew--new.json', stub('show-b', 'ew', 'https://ew.com/new-2', '2026-09-29T03:00:00Z'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add');
    const before = git(repo, 'rev-parse', 'HEAD');
    // Simulate the loss: HEAD moves to a descendant of before~1 without the file.
    git(repo, 'reset', '-q', '--hard', base);
    write(repo, 'other.txt', 'y\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'rewritten without the new file');

    const r = runCheck(repo, before);
    assert.equal(r.status, 1, `expected a drop to be reported\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /_pending\/show-b\/ew--new\.json/);
  });

  test('every added-file diff in the survival/guard paths opts out of rename pairing', () => {
    // Same class as the bug above: with rename detection on, an ADDED file
    // paired with an unrelated deletion is reported as R and silently falls
    // out of any --diff-filter that lists A (conflict-marker guards included).
    const offenders = [];
    for (const file of GUARDED_FILES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(#|\/\/|\*)/.test(line)) return;
        const m = line.match(/diff-filter=(\$\{|[A-Z]+)/);
        // A dynamic filter (${...}) may include A, so it is held to the same rule.
        if (m && (m[1] === '${' || m[1].includes('A')) && !/no-renames/.test(line)) offenders.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
