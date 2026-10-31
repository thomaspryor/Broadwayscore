// BRO-3208 / BRO-5261: fix-stale-upcoming-tags.js decision logic, against a
// throwaway shows.json through the real shows-write-guard.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { run, findStaleUpcomingTargets } = require('../../scripts/fix-stale-upcoming-tags.js');
const { createShowsWriteGuard } = require('../../scripts/lib/shows-write-guard');

let tmpDir;
let showsPath;
const quiet = { log: () => {}, logError: () => {} };

// Filler rows keep the fixture large enough that dropping a few tag lines
// stays under atomicWriteJson's 5% shrink gate.
const FILLER = Array.from({ length: 40 }, (_, i) => ({ id: `filler-${i}`, status: 'open', tags: ['musical'] }));

function seed(shows) {
  fs.writeFileSync(
    showsPath,
    JSON.stringify({ _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' }, shows: [...shows, ...FILLER] }, null, 2) + '\n',
  );
}
function onDisk(id) {
  return JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows.find((s) => s.id === id);
}
function guardDeps() {
  const g = createShowsWriteGuard(showsPath);
  return { loadShows: g.loadShows, saveShows: g.saveShows, ...quiet };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-stale-upcoming-'));
  showsPath = path.join(tmpDir, 'shows.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findStaleUpcomingTargets', () => {
  const shows = [
    { id: 'open-1', status: 'open', tags: ['upcoming'] },
    { id: 'prev-1', status: 'previews', tags: ['Upcoming', 'drama'] },
    { id: 'closed-1', status: 'closed', tags: ['UPCOMING'] },
    { id: 'up-1', status: 'upcoming', tags: ['upcoming'] },
    { id: 'ann-1', status: 'announced', tags: ['upcoming'] },
    { id: 'clean-1', status: 'open', tags: ['musical'] },
  ];
  test('selects open/previews/closed rows with the tag in any case', () => {
    assert.deepEqual(findStaleUpcomingTargets(shows).map((s) => s.id), ['open-1', 'prev-1', 'closed-1']);
  });
  test('--show scopes to one id', () => {
    assert.deepEqual(findStaleUpcomingTargets(shows, 'closed-1').map((s) => s.id), ['closed-1']);
    assert.deepEqual(findStaleUpcomingTargets(shows, 'up-1'), []);
  });
});

describe('run --check exit codes', () => {
  test('exits 1 when a stale tag remains and writes nothing', () => {
    seed([{ id: 'a', status: 'open', tags: ['upcoming'] }]);
    const before = fs.readFileSync(showsPath, 'utf8');
    assert.equal(run(['--check'], guardDeps()), 1);
    assert.equal(fs.readFileSync(showsPath, 'utf8'), before);
  });
  test('exits 0 when clean', () => {
    seed([{ id: 'a', status: 'upcoming', tags: ['upcoming'] }, { id: 'b', status: 'open', tags: ['musical'] }]);
    assert.equal(run(['--check'], guardDeps()), 0);
  });
  test('exits 2 when combined with --apply', () => {
    seed([{ id: 'a', status: 'open', tags: ['upcoming'] }]);
    assert.equal(run(['--check', '--apply'], guardDeps()), 2);
    assert.deepEqual(onDisk('a').tags, ['upcoming']);
  });
  test('exits 0 after --apply has cleared the stale tags', () => {
    seed([{ id: 'a', status: 'open', tags: ['upcoming', 'musical'] }]);
    assert.equal(run(['--apply'], guardDeps()), 0);
    assert.equal(run(['--check'], guardDeps()), 0);
  });
});

describe('run --apply', () => {
  test('strips mixed-case Upcoming and leaves other tags and non-past statuses alone', () => {
    seed([
      { id: 'prev', status: 'previews', tags: ['Upcoming', 'drama'] },
      { id: 'closed', status: 'closed', tags: ['UPCOMING', 'musical'] },
      { id: 'up', status: 'upcoming', tags: ['upcoming', 'musical'] },
      { id: 'ann', status: 'announced', tags: ['Upcoming', 'play'] },
    ]);
    assert.equal(run(['--apply'], guardDeps()), 0);
    assert.deepEqual(onDisk('prev').tags, ['drama']);
    assert.deepEqual(onDisk('closed').tags, ['musical']);
    assert.deepEqual(onDisk('up').tags, ['upcoming', 'musical']);
    assert.deepEqual(onDisk('ann').tags, ['Upcoming', 'play']);
  });

  test('dry run (no flags) reports but does not write', () => {
    seed([{ id: 'a', status: 'open', tags: ['upcoming', 'musical'] }]);
    assert.equal(run([], guardDeps()), 0);
    assert.deepEqual(onDisk('a').tags, ['upcoming', 'musical']);
  });

  test('keeps a concurrent edit to the same show made after load (mutateFresh)', () => {
    seed([{ id: 'a', status: 'open', tags: ['upcoming', 'musical'] }]);
    const g = createShowsWriteGuard(showsPath);
    const other = createShowsWriteGuard(showsPath);
    const deps = {
      ...quiet,
      saveShows: g.saveShows,
      loadShows() {
        const data = g.loadShows();
        // Another writer adds a tag to the same show between our load and save.
        const theirs = other.loadShows();
        theirs.shows.find((s) => s.id === 'a').tags.push('drama');
        other.saveShows(theirs);
        return data;
      },
    };
    assert.equal(run(['--apply'], deps), 0);
    assert.deepEqual(onDisk('a').tags, ['musical', 'drama']);
  });

  test('skips the write when the tag was already cleared by the time the lock is held', () => {
    seed([{ id: 'a', status: 'open', tags: ['upcoming', 'musical'] }]);
    const g = createShowsWriteGuard(showsPath);
    const other = createShowsWriteGuard(showsPath);
    let afterOther;
    const deps = {
      ...quiet,
      saveShows: g.saveShows,
      loadShows() {
        const data = g.loadShows();
        const theirs = other.loadShows();
        theirs.shows.find((s) => s.id === 'a').tags = ['musical'];
        other.saveShows(theirs);
        afterOther = fs.readFileSync(showsPath, 'utf8');
        return data;
      },
    };
    assert.equal(run(['--apply'], deps), 0);
    assert.equal(fs.readFileSync(showsPath, 'utf8'), afterOther);
  });
});
