// TESTS-VS-DERIVED-DATA-EXEMPT: synthetic JSON in an isolated temp directory only; no live data is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseArgs, verifyBackfill, main } = require('../../scripts/lib/verify-data-backfill.js');
const { isSafeCheckCommand } = require('../../scripts/lib/verify-gate.js');

test('backfill probe requires explicit safe IDs and positive review minima', () => {
  const options = parseArgs(['--show=one-2026,two-2026', '--images', '--reviews=2']);
  assert.deepEqual(options, { showIds: ['one-2026', 'two-2026'], images: true, minReviews: 2 });
  for (const args of [[], ['--show=../shows'], ['--show=one', '--reviews=0'], ['--show=one', '--fix'], ['--show=one', '--reviews=1', '--images']]) {
    assert.throws(() => parseArgs(args));
    assert.equal(isSafeCheckCommand(`node scripts/lib/verify-data-backfill.js ${args.join(' ')}`), false);
  }
  assert.equal(isSafeCheckCommand('node scripts/lib/verify-data-backfill.js --show=one-2026,two-2026 --images --reviews=2'), true);
});

test('backfill probe checks each show and uses the canonical image predicate', () => {
  const options = parseArgs(['--show=one,two,missing', '--images', '--reviews=1']);
  const results = verifyBackfill([
    { id: 'one', images: { poster: '/images/not-a-real-poster.jpg' } },
    { id: 'two', images: { poster: 'https://example.com/poster.jpg' } },
  ], [
    { showId: 'one', assignedScore: null }, { showId: 'two', assignedScore: 80 },
  ], options);
  assert.deepEqual(results.map(r => r.ok), [false, true, false]);
  assert.deepEqual(results[0].problems, ['usable image missing', 'scored reviews 0 < 1']);
  assert.ok(results[2].problems.includes('show missing'));
});

test('backfill CLI fails closed on missing data and unmet expectations, without writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5266-'));
  try {
    assert.equal(main(['--show=one'], root), 2);
    fs.mkdirSync(path.join(root, 'data'));
    const shows = JSON.stringify({ shows: [{ id: 'one' }] });
    fs.writeFileSync(path.join(root, 'data/shows.json'), shows);
    fs.writeFileSync(path.join(root, 'data/reviews.json'), JSON.stringify({ reviews: [] }));
    assert.equal(main(['--show=one'], root), 0);
    assert.equal(main(['--show=one', '--images'], root), 1);
    assert.equal(main(['--show=one', '--reviews=1'], root), 1);
    assert.equal(main(['--show=missing'], root), 1);
    assert.equal(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'), shows);
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')).sort(), ['reviews.json', 'shows.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
