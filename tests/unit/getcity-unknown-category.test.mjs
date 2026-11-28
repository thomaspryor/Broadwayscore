// BRO-2485 S4-T3: an unrecognized category must bucket to 'nyc', never its own dead-end bucket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryToCityBucket } from '../../src/lib/city-bucket.ts';

test('known categories keep their buckets', () => {
  assert.equal(categoryToCityBucket('broadway'), 'nyc');
  assert.equal(categoryToCityBucket('off-broadway'), 'nyc');
  assert.equal(categoryToCityBucket('west-end'), 'london');
  assert.equal(categoryToCityBucket('off-west-end'), 'london');
  assert.equal(categoryToCityBucket('regional'), 'regional');
  assert.equal(categoryToCityBucket('tour'), 'tour');
  assert.equal(categoryToCityBucket(undefined), 'nyc');
});

test('unrecognized categories fold into nyc', () => {
  for (const c of ['off-off-broadway', 'Broadway ', 'bogus', '']) {
    assert.equal(categoryToCityBucket(c), 'nyc', c);
  }
});

test('data-core getCity routes through the shared bucket function', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/lib/data-core.ts', import.meta.url), 'utf8');
  assert.match(src, /return categoryToCityBucket\(cat\)/);
});
