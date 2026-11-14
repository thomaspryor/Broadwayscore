import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isLateTheatreRecordReviewOfBroadwayShow: late } = require('./tr-late-review-guard.js');

const chicago = { id: 'chicago-1996', category: 'broadway', openingDate: '1996-11-14' };
const inRun = (d, runs) => (runs || []).some((r) => d >= new Date(r.openingDate) && d <= new Date(r.closingDate));

test('a TR review a year after a Broadway opening is a London production (chicago-1996, Daily Mail 1997)', () => {
  assert.equal(late(chicago, '1997-11-21'), true);
});

test('opening-window reviews, West End shows, and declared prior runs are not flagged', () => {
  assert.equal(late(chicago, '1996-11-20'), false);
  assert.equal(late({ ...chicago, category: 'west-end' }, '1997-11-21'), false);
  const withRun = { ...chicago, priorRuns: [{ openingDate: '1997-11-18', closingDate: '2012-09-01', venue: 'Adelphi Theatre, London' }] };
  assert.equal(late(withRun, '1997-11-21', { isWithinPriorRun: inRun }), false);
  assert.equal(late(chicago, null), false);
});

// BRO-5429: the rebuild's dual-market UK guard reuses the same date rule.
test('evaluateLateDualMarketUkOnBroadway: only UK-region dual-market outlets, only late dates', () => {
  const { evaluateLateDualMarketUkOnBroadway: g } = require('./cross-market-guard.js');
  assert.equal(g({ show: chicago, publishDate: '1997-11-21', outletIsUkRegion: true, outletIsDualMarket: true }).shouldFlag, true);
  assert.equal(g({ show: chicago, publishDate: '1996-11-15', outletIsUkRegion: true, outletIsDualMarket: true }).shouldFlag, false);
  assert.equal(g({ show: chicago, publishDate: '1997-11-21', outletIsUkRegion: false, outletIsDualMarket: true }).shouldFlag, false, 'NY Theatre Guide / NY Observer (dual, not UK) keep later-run reviews');
  assert.equal(g({ show: chicago, publishDate: '1997-11-21', outletIsUkRegion: true, outletIsDualMarket: false }).shouldFlag, false, 'non-dual UK outlets are the reverse guard\'s');
});

test('evaluateLateDualMarketUkOnBroadway: a url naming Broadway / New York is a US-edition piece, not flagged', () => {
  const { evaluateLateDualMarketUkOnBroadway: g } = require('./cross-market-guard.js');
  const hedwig = { id: 'hedwig-and-the-angry-inch-2014', category: 'broadway', openingDate: '2014-04-22' };
  const base = { show: hedwig, publishDate: '2015-07-23', outletIsUkRegion: true, outletIsDualMarket: true };
  assert.equal(g({ ...base, url: 'https://www.dailymail.co.uk/tvshowbiz/article-3171727/Taye-Diggs-makes-debut-in-Broadway-s-Hedwig-Angry-Inch.html' }).shouldFlag, false);
  assert.equal(g({ ...base, url: 'https://www.theguardian.com/stage/2015/jul/23/hedwig-review-new-york' }).shouldFlag, false);
  assert.equal(g({ ...base, url: 'http://www.guardian.co.uk/stage/2010/nov/17/fela-review' }).shouldFlag, true, 'a London review url still flags');
  assert.equal(g({ ...base, url: null }).shouldFlag, true, 'Theatre Record rows have no url');
});
