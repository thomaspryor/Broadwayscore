import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreFromSlimShow } = require('./newsletter-score.js');

test('slim file with cs/rc gives the canonical score', () => {
  assert.deepEqual(scoreFromSlimShow({ id: 'x', cs: 82.88, rc: 25 }), { avg: 83, count: 25, raw: 82.88 });
});

test('slim file without cs (site withholds the score) gives null, never a fallback', () => {
  // The Dog Show: Come. Sit. Stay. on 2026-10-25: 3 reviews in rv, coverage
  // incomplete, no cs. The newsletter printed a raw-mean 79.
  const slim = { _v: 3, id: 'the-dog-show-come-sit-stay-off-broadway-2026', cat: 'off-broadway',
    bd: { positive: 3, mixed: 0, negative: 0 }, rv: [{ s: 78 }, { s: 84 }, { s: 75 }],
    cov: { state: 'incomplete', liveCount: 4, candidateCount: 6 } };
  assert.equal(scoreFromSlimShow(slim), null);
});

test('missing slim file is undefined so the caller can tell it apart', () => {
  assert.equal(scoreFromSlimShow(null), undefined);
});
