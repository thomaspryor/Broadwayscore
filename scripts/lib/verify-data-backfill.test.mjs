// BRO-7568: season tokens are refused as show ids (BRO-6503's VERIFY could never pass).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs } = require('./verify-data-backfill.js');

test('a season token is refused with a pointer to the season audit', () => {
  for (const tok of ['we-2011-12', 'we-2010-2011', 'bw-2024-25']) {
    assert.throws(() => parseArgs([`--show=top-hat-west-end-2012,${tok}`]), /is a season, not a show.*audit-we-historical-season/);
  }
});

test('real show ids, including ones ending in a year, still parse', () => {
  const r = parseArgs(['--show=top-hat-west-end-2012,we-will-rock-you-west-end-2002', '--images']);
  assert.deepStrictEqual(r.showIds, ['top-hat-west-end-2012', 'we-will-rock-you-west-end-2002']);
  assert.equal(r.images, true);
});
