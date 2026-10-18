// BRO-5604: appending his first Reddit anchor must not hide a reported cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { appendWaltzAnchors, waltzAnchor } = require('./waltz-cost-history.js');
const { hasCostAnchor } = require('./cost-for-week.js');

const post = { id: 'abc123', created_utc: Date.parse('2025-03-03') / 1000, permalink: '/r/Broadway/comments/abc123/x/', title: 'Weekly New Musical Grosses Analysis- Week Ending 3/2/2025' };

test('trade-anchored record keeps hasCostAnchor after the first Waltz anchor', () => {
  const record = {
    weeklyRunningCost: 900000,
    costMethodology: 'trade-reported',
    weeklyRunningCostSource: 'Variety, 2025-01-15',
    sources: [{ type: 'trade', url: 'https://variety.com/x', date: '2025-01-15' }],
  };
  const show = { slug: 'x-show', openingDate: '2025-02-01' };
  assert.equal(hasCostAnchor(record, show), true, 'precondition: reported cost counts');
  const shows = { 'x-show': record };
  const res = appendWaltzAnchors(shows, [{ slug: 'x-show', anchor: waltzAnchor(post, 910000) }], { apply: true, showsBySlug: { 'x-show': show } });
  assert.equal(res.added, 1);
  assert.ok(record.costHistory.length >= 2, 'legacy anchor kept alongside the Reddit one');
  assert.equal(hasCostAnchor(record, show), true, 'dated costs must stay on');
});
