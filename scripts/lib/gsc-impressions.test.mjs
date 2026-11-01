// BRO-6769: /opera pages are tracked in the GSC snapshot; opera queries aggregate per query.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { normalizePagePath, aggregateRows, aggregateOperaQueries } = createRequire(import.meta.url)('./gsc-impressions.js');

test('opera pages are tracked, others are not', () => {
  assert.equal(normalizePagePath('https://www.broadwayscorecard.com/opera/tosca/'), '/opera/tosca');
  assert.equal(normalizePagePath('https://broadwayscorecard.com/show/hamilton'), '/show/hamilton');
  assert.equal(normalizePagePath('https://www.broadwayscorecard.com/browse'), null);
  const r = aggregateRows([
    { keys: ['https://www.broadwayscorecard.com/opera/tosca'], impressions: 5 },
    { keys: ['https://broadwayscorecard.com/opera/tosca/'], impressions: 3 },
  ]);
  assert.deepEqual(r, { '/opera/tosca': 8 });
});

test('aggregateOperaQueries sums, ranks and ignores non-opera pages', () => {
  const out = aggregateOperaQueries([
    { keys: ['tosca met review', 'https://www.broadwayscorecard.com/opera/tosca'], impressions: 10, clicks: 1 },
    { keys: ['tosca met review', 'https://broadwayscorecard.com/opera/tosca/'], impressions: 5, clicks: 0 },
    { keys: ['hamilton', 'https://www.broadwayscorecard.com/show/hamilton'], impressions: 99, clicks: 9 },
    { keys: ['met live in hd medea review', 'https://www.broadwayscorecard.com/opera/medea'], impressions: 20, clicks: 2 },
  ]);
  assert.deepEqual(out.map(q => [q.query, q.impressions, q.clicks, q.topPage]), [
    ['met live in hd medea review', 20, 2, '/opera/medea'],
    ['tosca met review', 15, 1, '/opera/tosca'],
  ]);
});
