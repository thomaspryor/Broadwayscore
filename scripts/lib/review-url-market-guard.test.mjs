import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isOffBroadwayUrlForBroadwayShow: g } = createRequire(import.meta.url)('./review-url-market-guard.js');

const bw = { category: 'broadway' };
test('rejects off-broadway path for broadway show (BRO-6055)', () => {
  assert.equal(g('http://www.theatermania.com/off-broadway/reviews/indecent_77094.html', bw), true);
});
test('allows broadway path', () => {
  assert.equal(g('http://www.theatermania.com/broadway/reviews/indecent_80762.html', bw), false);
});
test('allows when priorRuns declared', () => {
  assert.equal(g('http://x.com/off-broadway/reviews/a.html', { ...bw, priorRuns: [{}] }), false);
});
test('ignores non-broadway shows and missing input', () => {
  assert.equal(g('http://x.com/off-broadway/a', { category: 'off-broadway' }), false);
  assert.equal(g(null, bw), false);
  assert.equal(g('http://x.com/off-broadway/reviews/a', null), false);
  assert.equal(g('http://x.com/off-broadway/news/a', bw), false);
});
