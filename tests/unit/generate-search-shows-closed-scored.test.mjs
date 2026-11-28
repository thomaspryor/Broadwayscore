import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildShowsWithScores } = require('../../scripts/lib/search-shows-scores');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-shows-scores-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSlim(dir, id, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data));
}

describe('buildShowsWithScores (BRO-339)', () => {
  test('includes a closed show scored only via public/data/shows/{id}.json (reviews.json has no row)', () => {
    const shows = [{ id: 'assassins-2004' }];
    const reviews = []; // no reviews.json rows for this show at all
    const slimDir = path.join(tmpDir, 'shows');
    writeSlim(slimDir, 'assassins-2004', { id: 'assassins-2004', cs: 80 });

    const result = buildShowsWithScores(reviews, shows, slimDir);
    assert.equal(result.has('assassins-2004'), true);
  });

  test('still includes a show scored only via a reviews.json row (no slim file present)', () => {
    const shows = [{ id: 'hamilton-2015' }];
    const reviews = [{ showId: 'hamilton-2015', assignedScore: 92 }];
    const slimDir = path.join(tmpDir, 'shows'); // never created

    const result = buildShowsWithScores(reviews, shows, slimDir);
    assert.equal(result.has('hamilton-2015'), true);
  });

  test('excludes a closed show with no score in either source', () => {
    const shows = [{ id: 'some-flop-1999' }];
    const reviews = [];
    const slimDir = path.join(tmpDir, 'shows');
    writeSlim(slimDir, 'some-flop-1999', { id: 'some-flop-1999' }); // no cs field

    const result = buildShowsWithScores(reviews, shows, slimDir);
    assert.equal(result.has('some-flop-1999'), false);
  });

  test('does not add a show whose slim file cs is null (below min-review threshold)', () => {
    const shows = [{ id: 'too-few-reviews-2020' }];
    const reviews = [];
    const slimDir = path.join(tmpDir, 'shows');
    writeSlim(slimDir, 'too-few-reviews-2020', { id: 'too-few-reviews-2020', cs: null });

    const result = buildShowsWithScores(reviews, shows, slimDir);
    assert.equal(result.has('too-few-reviews-2020'), false);
  });

  test('tolerates a corrupt slim file without throwing', () => {
    const shows = [{ id: 'broken-json-2020' }];
    const reviews = [];
    const slimDir = path.join(tmpDir, 'shows');
    fs.mkdirSync(slimDir, { recursive: true });
    fs.writeFileSync(path.join(slimDir, 'broken-json-2020.json'), '{not valid json');

    const result = buildShowsWithScores(reviews, shows, slimDir);
    assert.equal(result.has('broken-json-2020'), false);
  });

  test('tolerates a missing public/data/shows directory entirely', () => {
    const shows = [{ id: 'hamilton-2015' }];
    const reviews = [{ showId: 'hamilton-2015', assignedScore: 92 }];
    const missingDir = path.join(tmpDir, 'does-not-exist');

    const result = buildShowsWithScores(reviews, shows, missingDir);
    assert.equal(result.has('hamilton-2015'), true);
  });
});
