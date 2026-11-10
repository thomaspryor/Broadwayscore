// node --test scripts/lib/city-hub-dual-audit.test.mjs  (BRO-7256)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const A = require('./city-hub-dual-audit.js');

test('star ratings map to the CLAUDE.md score bands', () => {
  assert.equal(A.starsFromRating('4/5'), 4);
  assert.equal(A.starsFromRating('3.5 out of 5'), 3.5);
  assert.equal(A.starsFromRating('8/10'), 4);
  assert.equal(A.starsFromRating('★★★½'), 3.5);
  assert.equal(A.starsFromRating('B+'), null);
  assert.equal(A.starBandProblem('4/5', 80), null);
  assert.match(A.starBandProblem('2/5', 70), /31-50/);
  assert.equal(A.starBandProblem('3.5/5', 70), null); // half star spans two bands
  assert.equal(A.starBandProblem('B+', 12), null); // not a star rating: no opinion
});

test('verdict vs score flags only clear contradictions', () => {
  assert.equal(A.verdictProblem('positive', 75), null);
  assert.ok(A.verdictProblem('rave', 40));
  assert.ok(A.verdictProblem('pan', 90));
  assert.equal(A.verdictProblem('unclear', 5), null);
});

test('pull quote must be a real sentence of the article', () => {
  const text = 'The staging is dazzling. “A wry, tender night of theatre that earns every laugh,” writes the critic, and means it.';
  assert.equal(A.quoteInText('A wry, tender night of theatre that earns every laugh', text), true);
  assert.equal(A.quoteInText('An unforgettable evening of pure genius at the Kreeger', text), false);
  assert.equal(A.quoteInText('', text), null);
});

test('byline matching is token based and ignores accents', () => {
  assert.equal(A.bylineMatches('Peter Marks', 'By Peter Marks, Critic'), true);
  assert.equal(A.bylineMatches('Peter Marks', 'Jane Smith'), false);
  assert.equal(A.bylineMatches('Unknown', null), null);
});

test('review flags compare blind extraction with our row, not the other way round', () => {
  const row = { criticName: 'Jane Doe', publishDate: '2026-06-01', assignedScore: 90, originalRating: '4/5' };
  const ok = { isReview: 'review', matchesProduction: 'yes', bylineInText: 'Jane Doe', publishDateInText: '2026-06-02', verdict: 'positive', ratingInText: '4 out of 5' };
  assert.deepEqual(A.reviewFlags(row, ok, { opening: '2026-05-30', closing: '2026-07-01' }), []);
  const bad = { isReview: 'roundup', matchesProduction: 'no', bylineInText: 'John Roe', publishDateInText: '2026-01-01', verdict: 'pan', ratingInText: '2/5' };
  const codes = A.reviewFlags(row, bad, { opening: '2026-05-30', closing: '2026-07-01' }).map((f) => f.code);
  for (const c of ['wrong-production', 'non-review:roundup', 'byline', 'publish-date', 'pre-run-date', 'star-band', 'score-vs-text']) assert.ok(codes.includes(c), c);
  assert.equal(A.reviewFlags(row, null)[0].code, 'no-output');
});

test('show flags: dates compared with tolerance, never anchored on our record', () => {
  const show = { title: 'Hundred Days', venue: 'Keegan Theatre', openingDate: '2026-10-13', closingDate: '2026-11-15', category: 'regional' };
  assert.deepEqual(A.showFlags(show, { pageIsAboutProduction: 'yes', title: 'Hundred Days', venue: 'Keegan Theatre', opening: '2026-10-14', closing: '2026-11-15' }), []);
  const codes = A.showFlags(show, { pageIsAboutProduction: 'yes', title: 'Hundred Days', venue: 'Keegan Theatre', opening: '2026-10-13', closing: '2026-12-20', productionType: 'tour' }).map((f) => f.code);
  assert.deepEqual(codes, ['closing-date', 'category']);
});

test('hubPhase matches the TypeScript contract (src/lib/city-hub.ts)', () => {
  const t = '2026-11-10';
  assert.equal(A.hubPhase({ status: 'closed' }, t), 'closed');
  assert.equal(A.hubPhase({ status: 'open', closingDate: '2026-11-09' }, t), 'closed');
  assert.equal(A.hubPhase({ status: 'open', openingDate: '2026-10-01', closingDate: '2026-11-15' }, t), 'now');
  assert.equal(A.hubPhase({ status: 'upcoming', openingDate: '2026-12-01' }, t), 'soon');
  assert.equal(A.hubPhase({ status: 'open', openingDate: '2026-09-01', closingDate: '2026-12-01', closingDateSource: 'estimated' }, t), 'closed');
  const src = fs.readFileSync(new URL('../../src/lib/city-hub.ts', import.meta.url), 'utf8');
  assert.match(src, /ESTIMATED_RUN_DAYS = 42/);
  assert.match(src, /RECENT_DAYS = 365/);
  assert.match(src, /CLOSED_LIMIT = 12/);
});

test('sectionHubShows caps Recently closed at 12 and hides pre-launch history', () => {
  const closed = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, city: 'x', status: 'closed', openingDate: `2026-06-${String(i + 1).padStart(2, '0')}`, closingDate: `2026-07-${String(i + 1).padStart(2, '0')}` }));
  closed.push({ id: 'old', city: 'x', status: 'closed', openingDate: '2026-01-01', closingDate: '2026-02-01' });
  const out = A.sectionHubShows(closed, 'x', '2026-05-01', '2026-11-10');
  assert.equal(out.closedRecent.length, 12);
  assert.equal(out.archive.length, 3);
  assert.ok(![...out.closedRecent, ...out.archive].some((s) => s.id === 'old'));
});

test('parseLiveHub reads the three headings of a rendered hub page', () => {
  const html = '<h2>Now playing</h2><div>Keegan Theatre</div><h3>Hundred Days</h3><span>MUSICAL</span><h2>Coming soon</h2><div>National Theatre</div><h3>Hell&#x27;s Kitchen</h3><span>MUSICAL</span><h2>Recently closed</h2><div>Arena Stage</div><h3>Mexodus</h3><span>PLAY</span>';
  const out = A.parseLiveHub(html);
  assert.deepEqual(out.now.map((x) => x.title), ['Hundred Days']);
  assert.deepEqual(out.soon.map((x) => x.title), ["Hell's Kitchen"]);
  assert.deepEqual(out.closed.map((x) => x.title), ['Mexodus']);
});

test('image flags: other title or placeholder flags, matching title does not', () => {
  const show = { title: 'Paranormal Activity' };
  assert.deepEqual(A.imageFlags(show, { visibleTitle: 'PARANORMAL ACTIVITY', isPlaceholderOrBanner: false }), []);
  assert.equal(A.imageFlags(show, { visibleTitle: 'Hamilton', isPlaceholderOrBanner: false })[0].code, 'image-other-title');
  assert.equal(A.imageFlags(show, { visibleTitle: null, isPlaceholderOrBanner: true })[0].code, 'image-not-key-art');
});

test('review text that announces a later run end is found (stale theatre-page closing dates)', () => {
  const t = 'A Case for the Existence of God. Through November 21 at the Matrix Theatre.';
  assert.deepEqual(A.runEndsInText(t, 2026), ['2026-11-21']);
  assert.equal(A.laterRunEnd(t, '2026-10-11'), '2026-11-21');
  assert.equal(A.laterRunEnd(t, '2026-11-21'), null);
  assert.equal(A.laterRunEnd('Extended through Sept. 27, 2026.', '2026-09-20'), '2026-09-27');
  assert.equal(A.laterRunEnd('No dates here', '2026-09-20'), null);
});

test('"3 stars (of a possible 4)" is read on the 4-star scale', () => {
  assert.equal(A.starsFromRating('3 stars (of a possible 4)'), 4);
  assert.equal(A.starBandProblem('3 stars (of a possible 4)', 80), null);
});
