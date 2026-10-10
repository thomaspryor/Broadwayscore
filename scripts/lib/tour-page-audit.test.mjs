import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isShowScoreStatusEligible } = require('./showscore-status-eligibility.js');
const { checkTourData } = require('./tour-page-audit.js');

// BRO-4876: ShowScore "Closed" on a tour's borrowed URL closed the live
// Operation Mincemeat tour with no closingDate; the audit then saw 24 future stops.
const urls = { 'operation-mincemeat-tour-2026': 'x', 'a-show': 'y' };

test('ShowScore refresh never touches tours', () => {
  assert.equal(isShowScoreStatusEligible({ id: 'operation-mincemeat-tour-2026', category: 'tour', status: 'open' }, urls), false);
});
test('ShowScore refresh still covers open non-tour shows with a URL', () => {
  assert.equal(isShowScoreStatusEligible({ id: 'a-show', category: 'broadway', status: 'open' }, urls), true);
  assert.equal(isShowScoreStatusEligible({ id: 'a-show', category: 'off-broadway', status: 'previews' }, urls), true);
  assert.equal(isShowScoreStatusEligible({ id: 'a-show', category: 'broadway', status: 'closed' }, urls), false);
  assert.equal(isShowScoreStatusEligible({ id: 'nope', category: 'broadway', status: 'open' }, urls), false);
});
test('audit flags a closed tour that still has future stops', () => {
  const show = { id: 't', title: 'T', category: 'tour', status: 'closed', closingDate: null, openingDate: '2026-09-20', images: { poster: '/images/shows/t/poster.webp' }, synopsis: 'x'.repeat(50) };
  const schedule = { stops: [{ city: 'Boston, MA', venue: 'V', start: '2026-12-01', end: '2026-12-06' }] };
  const out = checkTourData({ show, parent: null, schedule, today: '2026-10-08' });
  assert.ok(out.some(f => f.code === 'closed-tour-has-future-stops'));
});
