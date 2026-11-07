import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSiblingIndex, resolveWriteTarget } = require('../../scripts/lib/market-routing');
const { classifyIngestSkip } = require('../../scripts/lib/ingest-skip-classify');

const shows = [
  { id: 'wicked-2003', title: 'Wicked', category: 'broadway', openingDate: '2003-10-30' },
  { id: 'wicked-tour-2005', title: 'Wicked', category: 'tour', openingDate: '2005-03-09', closingDate: '2012-01-15' },
  { id: 'wicked-tour-2013', title: 'Wicked', category: 'tour', openingDate: '2013-03-01' },
];
const siblingIndex = buildSiblingIndex(shows);
const route = (url, publishDate, dateSource = 'article') => resolveWriteTarget({
  showId: 'wicked-tour-2013', category: 'tour', siblingIndex, url, publishDate, dateSource,
});

// BRO-5489: the shared writer passes decision.reason to ingest's "Skipped:"
// output unchanged. Both tour refusal paths must speak the audit's skip contract.
test('a UK production refused on a US tour is an expected ingest rejection', () => {
  const decision = route('https://www.thestage.co.uk/reviews/wicked', '2019-05-01');
  assert.equal(decision.action, 'reject');
  const skip = classifyIngestSkip(`Skipped: ${decision.reason}`);
  assert.equal(skip.kind, 'expected');
  assert.equal(skip.reason, 'tour-review');
});

test('a review outside all tour windows is an expected ingest rejection', () => {
  const decision = route('https://www.nytimes.com/reviews/wicked', '2003-10-31');
  assert.equal(decision.action, 'reject');
  const skip = classifyIngestSkip(`Skipped: ${decision.reason}`);
  assert.equal(skip.kind, 'expected');
  assert.equal(skip.reason, 'tour-review');
});

test('valid tour coverage stays accepted and earlier tour coverage reroutes', () => {
  assert.equal(route('https://www.denverpost.com/wicked', '2019-05-01').action, 'accept');
  const earlier = route('https://www.denverpost.com/wicked', '2008-05-01');
  assert.equal(earlier.action, 'reroute');
  assert.equal(earlier.targetShowId, 'wicked-tour-2005');
});

test('missing or untrusted dates cannot cause a date-window refusal', () => {
  assert.equal(route('https://www.denverpost.com/wicked', null).action, 'accept');
  assert.equal(route('https://www.denverpost.com/wicked', '2003-10-31', 'url-backfill-url-ymd').action, 'accept');
});
