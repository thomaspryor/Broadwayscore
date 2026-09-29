import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDuplicateUrls, findConflictingShowId, isShowScoreNotFoundPage, decideDeadUrlAction } = require('./show-score-url-map.js');

// BRO-4358: Show Score's real 404 page, as served for a dead show URL.
test('isShowScoreNotFoundPage: recognizes Show Score\'s real 404 page', () => {
  const html = '<!DOCTYPE html><html><head><title>The page you were looking for doesn\'t exist (404)</title></head>'
    + '<body><h1>404 &ndash; Not Found</h1><a href="/">show_score</a></body></html>';
  assert.equal(isShowScoreNotFoundPage(html), true);
});

test('isShowScoreNotFoundPage: loose legacy markers do NOT count (a true result uncaches a URL)', () => {
  assert.equal(isShowScoreNotFoundPage('<h1>Page not found</h1>'), false);
  assert.equal(isShowScoreNotFoundPage('<p>Act 2 runs 404 - 410 minutes, joked one reviewer</p>'), false);
});

test('isShowScoreNotFoundPage: a real show page is not a 404, even if its text mentions one', () => {
  const html = '<title>School Girls | Show Score</title><script type="application/ld+json">'
    + '{"name":"School Girls","aggregateRating":{"ratingValue":93,"reviewCount":211}}</script>'
    + '<p>review: this plot is a 404 &ndash; Not Found of logic</p>';
  assert.equal(isShowScoreNotFoundPage(html), false);
  assert.equal(isShowScoreNotFoundPage(''), false);
  assert.equal(isShowScoreNotFoundPage(null), false);
});

const DEAD = 'https://www.show-score.com/broadway-shows/school-girls-or-the-african-mean-girls-play-broadway';
const LIVE = `${DEAD}-2026`;

test('decideDeadUrlAction: a different valid page nobody owns replaces the dead url', () => {
  assert.equal(decideDeadUrlAction({ deadUrl: DEAD, rediscoveredUrl: LIVE, conflictId: null, budgetLeft: 3 }), 'replace');
});

test('decideDeadUrlAction: rediscovering the SAME url means the 404 was a one-off, so keep it', () => {
  assert.equal(decideDeadUrlAction({ deadUrl: DEAD, rediscoveredUrl: DEAD, conflictId: null, budgetLeft: 3 }), 'keep');
});

test('decideDeadUrlAction: nothing found, or only a page another show owns, drops it', () => {
  assert.equal(decideDeadUrlAction({ deadUrl: DEAD, rediscoveredUrl: null, conflictId: null, budgetLeft: 3 }), 'drop');
  assert.equal(decideDeadUrlAction({ deadUrl: DEAD, rediscoveredUrl: LIVE, conflictId: 'other-show', budgetLeft: 3 }), 'drop');
});

test('decideDeadUrlAction: a spent per-run budget keeps the cache untouched', () => {
  assert.equal(decideDeadUrlAction({ deadUrl: DEAD, rediscoveredUrl: null, conflictId: null, budgetLeft: 0 }), 'keep');
});

test('findDuplicateUrls: no duplicates when every url is unique', () => {
  const result = findDuplicateUrls({
    'show-a': 'https://www.show-score.com/broadway-shows/a',
    'show-b': 'https://www.show-score.com/broadway-shows/b',
  });
  assert.deepEqual(result, []);
});

test('findDuplicateUrls: flags two showIds sharing the same url', () => {
  const result = findDuplicateUrls({
    'wicked-west-end-2021': 'https://www.show-score.com/uk/london/west-end-shows/wicked-london',
    'wicked-west-end-2024': 'https://www.show-score.com/uk/london/west-end-shows/wicked-london',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://www.show-score.com/uk/london/west-end-shows/wicked-london');
  assert.deepEqual(result[0].showIds.sort(), ['wicked-west-end-2021', 'wicked-west-end-2024']);
});

test('findDuplicateUrls: casing/trailing-slash drift still collides (same Show Score page)', () => {
  const result = findDuplicateUrls({
    'show-a': 'https://www.Show-Score.com/broadway-shows/Foo/',
    'show-b': 'https://www.show-score.com/broadway-shows/foo',
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].showIds.sort(), ['show-a', 'show-b']);
});

test('findDuplicateUrls: a genuine 3-way collision is one group, not three pairs', () => {
  const result = findDuplicateUrls({
    a: 'https://www.show-score.com/broadway-shows/foo',
    b: 'https://www.show-score.com/broadway-shows/foo',
    c: 'https://www.show-score.com/broadway-shows/foo',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].showIds.length, 3);
});

test('findDuplicateUrls: null/empty url entries are ignored, not treated as a shared "" key', () => {
  const result = findDuplicateUrls({
    a: null,
    b: '',
    c: undefined,
  });
  assert.deepEqual(result, []);
});

test('findDuplicateUrls: tolerates a missing/empty map', () => {
  assert.deepEqual(findDuplicateUrls({}), []);
  assert.deepEqual(findDuplicateUrls(undefined), []);
});

test('findDuplicateUrls: raw (non-normalized) url is preserved in the report', () => {
  const result = findDuplicateUrls({
    a: 'https://www.Show-Score.com/Broadway-Shows/Foo/',
    b: 'https://www.show-score.com/broadway-shows/foo',
  });
  assert.equal(result.length, 1);
  // Whichever entry is seen first wins — Object.entries preserves insertion order.
  assert.equal(result[0].url, 'https://www.Show-Score.com/Broadway-Shows/Foo/');
});

// BRO-4055: writer-side guard. A hand-removed mapping (she-loves-me-1994,
// BRO-3416) kept coming back because writers only checked "does this showId
// already have a url", never "does this url already belong to a different
// showId". findConflictingShowId is the check that closes that gap — every
// writer that assigns urlData.shows[id] = url must call it first.
test('findConflictingShowId: refuses a url already mapped to a different showId', () => {
  const urlMap = { 'she-loves-me-2016': 'https://www.show-score.com/broadway-shows/she-loves-me' };
  const conflict = findConflictingShowId(urlMap, 'she-loves-me-1994', 'https://www.show-score.com/broadway-shows/she-loves-me');
  assert.equal(conflict, 'she-loves-me-2016');
});

test('findConflictingShowId: allows re-assigning the same url to the same showId (no-op update)', () => {
  const urlMap = { 'hamilton-2015': 'https://www.show-score.com/broadway-shows/hamilton' };
  const conflict = findConflictingShowId(urlMap, 'hamilton-2015', 'https://www.show-score.com/broadway-shows/hamilton');
  assert.equal(conflict, null);
});

test('findConflictingShowId: allows a genuinely unclaimed url', () => {
  const urlMap = { 'hamilton-2015': 'https://www.show-score.com/broadway-shows/hamilton' };
  const conflict = findConflictingShowId(urlMap, 'wicked-2003', 'https://www.show-score.com/broadway-shows/wicked');
  assert.equal(conflict, null);
});

test('findConflictingShowId: catches casing/trailing-slash drift, not just exact string match', () => {
  const urlMap = { 'hamilton-2015': 'https://www.show-score.com/Broadway-Shows/Hamilton/' };
  const conflict = findConflictingShowId(urlMap, 'hamilton-revival-2030', 'https://www.show-score.com/broadway-shows/hamilton');
  assert.equal(conflict, 'hamilton-2015');
});

test('findConflictingShowId: null/empty url never conflicts', () => {
  const urlMap = { a: null, b: '' };
  assert.equal(findConflictingShowId(urlMap, 'c', null), null);
  assert.equal(findConflictingShowId(urlMap, 'c', ''), null);
});

test('findConflictingShowId: tolerates a missing/empty map', () => {
  assert.equal(findConflictingShowId({}, 'a', 'https://www.show-score.com/broadway-shows/foo'), null);
  assert.equal(findConflictingShowId(undefined, 'a', 'https://www.show-score.com/broadway-shows/foo'), null);
});
