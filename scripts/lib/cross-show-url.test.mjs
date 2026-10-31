import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectCrossShowUrlMismatch, buildShowSlugIndex } = require('./cross-show-url.js');

// Synthetic index so the test runs without data/shows.json (worktree + CI safe).
const SHOWS = [
  { id: 'schmigadoon-2026', title: 'Schmigadoon!' },
  { id: 'every-brilliant-thing-2026', title: 'Every Brilliant Thing' },
  { id: 'care-west-end-2026', title: 'Care' },
  { id: 'the-cherry-orchard-2026', title: 'The Cherry Orchard' },
  { id: 'romeo-and-juliet-west-end-2026', title: 'Romeo and Juliet' },
  { id: 'romeo-juliet-2024', title: 'Romeo + Juliet' },
  { id: 'kinky-boots-2013', title: 'Kinky Boots' },
  { id: 'kinky-boots-the-musical-west-end-2015', title: 'Kinky Boots the Musical' },
];
const index = buildShowSlugIndex(SHOWS);

function check(showId, url) {
  return detectCrossShowUrlMismatch(showId, url, { index });
}

test('flags Every Brilliant Thing URL filed under Schmigadoon (the 2026-06 incident)', () => {
  const r = check('schmigadoon-2026', 'https://www.nytimes.com/2026/03/12/theater/every-brilliant-thing-review-daniel-radcliffe.html');
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'every-brilliant-thing-2026');
});

test('leaves a genuine Schmigadoon review alone', () => {
  assert.equal(check('schmigadoon-2026', 'https://variety.com/2026/legit/reviews/schmigadoon-broadway-review-1236685975/'), null);
});

test('does not flag same-play different-production (connector-normalized)', () => {
  // romeo-and-juliet vs romeo + juliet — same play, must not cross-flag
  assert.equal(check('romeo-and-juliet-west-end-2026', 'https://www.nytimes.com/2024/03/01/theater/romeo-and-juliet-review.html'), null);
  assert.equal(check('romeo-juliet-2024', 'https://www.timeout.com/newyork/theater/romeo-and-juliet-review'), null);
});

test('does not flag prefix-related titles (Kinky Boots vs Kinky Boots the Musical)', () => {
  assert.equal(check('kinky-boots-2013', 'https://example.com/reviews/kinky-boots-the-musical-review'), null);
});

// BRO-6599: subtitle stripping turns "Beautiful: The Carole King Musical"
// into "beautiful", which also occurs in A Beautiful Noise's own review URLs.
const BEAUTIFUL_INDEX = buildShowSlugIndex([
  { id: 'a-beautiful-noise-the-neil-diamond-musical-2022', title: 'A Beautiful Noise, The Neil Diamond Musical' },
  { id: 'beautiful-the-carole-king-musical-regional-2023', title: 'Beautiful: The Carole King Musical' },
  { id: 'schmigadoon-2026', title: 'Schmigadoon!' },
]);

test('BRO-6599: real A Beautiful Noise reviews do not match the shortened Beautiful title', () => {
  for (const url of [
    'https://www.amny.com/entertainment/review-neil-diamond-a-beautiful-noise/',
    'https://www.broadwaynews.com/2022/12/04/in-broadways-a-beautiful-noise-the-music-is-more-interesting-than-the-man/',
    'https://www.broadwayworld.com/los-angeles/article/Review-A-BEAUTIFUL-NOISE-at-Hollywood-Pantages-Theater-20250709',
  ]) {
    assert.equal(detectCrossShowUrlMismatch('a-beautiful-noise-the-neil-diamond-musical-2022', url,
      { index: BEAUTIFUL_INDEX }), null, url);
  }
});

test('BRO-6599: a full Beautiful title still flags a genuine misfile under A Beautiful Noise', () => {
  const hit = detectCrossShowUrlMismatch('a-beautiful-noise-the-neil-diamond-musical-2022',
    'https://example.com/reviews/beautiful-the-carole-king-musical-review/', { index: BEAUTIFUL_INDEX });
  assert.equal(hit?.matchedShowId, 'beautiful-the-carole-king-musical-regional-2023');
});

test('BRO-6599: a shortened title still flags an unrelated show', () => {
  const hit = detectCrossShowUrlMismatch('schmigadoon-2026',
    'https://example.com/reviews/beautiful-review/', { index: BEAUTIFUL_INDEX });
  assert.equal(hit?.matchedShowId, 'beautiful-the-carole-king-musical-regional-2023');
});

test('BRO-6599: shortened-title subsets use whole words and require every word', () => {
  const idx = buildShowSlugIndex([
    { id: 'a-beautiful-noise-the-neil-diamond-musical-2022', title: 'A Beautiful Noise, The Neil Diamond Musical' },
    { id: 'noise-beautiful-2023', title: 'Noise Beautiful: A Play' },
    { id: 'beautiful-day-2023', title: 'Beautiful Day: A Play' },
    { id: 'beautifully-2023', title: 'Beautifully: A Play' },
  ]);
  const checkNoise = url => detectCrossShowUrlMismatch('a-beautiful-noise-the-neil-diamond-musical-2022', url, { index: idx });
  assert.equal(checkNoise('https://example.com/noise-beautiful-review/'), null);
  assert.equal(checkNoise('https://example.com/beautiful-day-review/')?.matchedShowId, 'beautiful-day-2023');
  assert.equal(checkNoise('https://example.com/beautifully-review/')?.matchedShowId, 'beautifully-2023');
});

test('BRO-6599: parenthetical subtitles and punctuation share the shortened-title guard', () => {
  for (const [showId, title, otherId, otherTitle, url] of [
    ['the-tragedy-of-macbeth-regional-2024', 'The Tragedy of Macbeth',
      'macbeth-an-undoing-off-broadway-2024', 'Macbeth (An Undoing)',
      'https://buzznews.net/theatre/theatre-reviews/item/5686-blood-and-brilliance-invictus-theatre-s-macbeth-stands-tall-in-chicago-theatre.html'],
    ['topdog-underdog-regional-2024', 'Topdog/Underdog',
      'underdog-the-other-other-bronte-west-end-2024', 'Underdog: The Other Other Bronte',
      'https://aroundthetownchicago.com/theatre-reviews/top-dog-underdog-reviewed-by-frank-meccia/'],
  ]) {
    const idx = buildShowSlugIndex([{ id: showId, title }, { id: otherId, title: otherTitle }]);
    assert.equal(detectCrossShowUrlMismatch(showId, url, { index: idx }), null, title);
  }
});

test('does not flag on common URL-path stopwords', () => {
  // "/broadway/" appears in ~most review URLs; "broadway" is excluded from the index.
  assert.equal(check('schmigadoon-2026', 'https://www.nytimes.com/2026/04/20/theater/broadway/schmigadoon-review.html'), null);
});

test('returns null when the filed show has a sub-8-char title (documented short-title limitation)', () => {
  // "Care" -> slug "care" (4 chars) is below the index threshold, so the guard
  // cannot evaluate it. This is why Care's Equus/Cherry-Orchard contaminants
  // were NOT caught by the URL guard and needed manual flagging.
  assert.equal(check('care-west-end-2026', 'https://www.londontheatre.co.uk/reviews/equus-review-menier'), null);
});

test('flags when URL clearly names a different distinctive show', () => {
  const r = check('schmigadoon-2026', 'https://exeuntnyc.com/reviews/review-every-brilliant-thing-at-the-hudson-theatre/');
  assert.ok(r);
  assert.equal(r.matchedShowId, 'every-brilliant-thing-2026');
});

// BRO-4977: a show titled with a bare URL word ("Broadway", 1987) was left out
// of the slug index, which switched this guard off for it: seven reviews of
// The Heart of Rock and Roll sat live on it. Fixture shows file, not the real
// data/shows.json (worktree + CI safe).
test('BRO-4977: a "Broadway"-titled show is still guarded, and its title cannot vouch', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const showsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xshow-')), 'shows.json');
  fs.writeFileSync(showsPath, JSON.stringify({ shows: [
    { id: 'broadway-1987', title: 'Broadway' },
    { id: 'heart-of-rock-and-roll-2024', title: 'The Heart of Rock and Roll' },
    { id: 'the-visit-2015', title: 'The Visit' },
    { id: 'chita-rivera-the-dancers-life-2005', title: "Chita Rivera: The Dancer's Life" },
  ] }));
  const hit = detectCrossShowUrlMismatch('broadway-1987', 'https://www.thewrap.com/the-heart-of-rock-and-roll-broadway-review/', { showsPath });
  assert.ok(hit && hit.matchedShowId === 'heart-of-rock-and-roll-2024', JSON.stringify(hit));
  assert.equal(detectCrossShowUrlMismatch('broadway-1987', 'https://www.nytimes.com/1987/06/26/theater/stage-broadway-revival.html', { showsPath }), null);
  // Other excluded titles keep the old behaviour (no new flags on The Visit).
  assert.equal(detectCrossShowUrlMismatch('the-visit-2015', 'https://variety.com/2015/legit/reviews/visit-review-broadway-chita-rivera-1201478/', { showsPath }), null);
});

// BRO-4986: outlets drop a leading "The" from the other show's slug.
test('bare "the-" slug: flags heart-of-rock-and-roll URL filed under another show', () => {
  const idx = buildShowSlugIndex([
    { id: 'the-heart-of-rock-and-roll-2024', title: 'The Heart of Rock and Roll' },
    { id: 'hells-kitchen-2024', title: "Hell's Kitchen" },
  ]);
  const r = detectCrossShowUrlMismatch('hells-kitchen-2024',
    'https://www.vulture.com/article/review-heart-of-rock-and-roll-broadway-huey-lewis.html', { index: idx });
  assert.ok(r, 'expected a mismatch');
  assert.equal(r.matchedShowId, 'the-heart-of-rock-and-roll-2024');
});

test('bare "the-" slug: one-word remainder ("performers") is ordinary prose, no flag', () => {
  const idx = buildShowSlugIndex([
    { id: 'the-performers-2012', title: 'The Performers' },
    { id: 'hells-kitchen-2024', title: "Hell's Kitchen" },
  ]);
  assert.equal(detectCrossShowUrlMismatch('hells-kitchen-2024',
    'https://example.com/theater/hells-kitchen-review-performers-shine', { index: idx }), null);
});

test('bare "the-" slug: remainder made of this show\'s own words is the same play, no flag', () => {
  const idx = buildShowSlugIndex([
    { id: 'the-pirates-of-penzance-1981', title: 'The Pirates of Penzance' },
    { id: 'pirates-the-penzance-musical-2026', title: 'Pirates! The Penzance Musical' },
  ]);
  assert.equal(detectCrossShowUrlMismatch('pirates-the-penzance-musical-2026',
    'https://example.com/theater/review-pirates-of-penzance-broadway', { index: idx }), null);
});

test('bare "the-" slug: "the-supporting-cast" is excluded as review prose', () => {
  const idx = buildShowSlugIndex([
    { id: 'the-supporting-cast-1981', title: 'The Supporting Cast' },
    { id: 'hells-kitchen-2024', title: "Hell's Kitchen" },
  ]);
  assert.equal(detectCrossShowUrlMismatch('hells-kitchen-2024',
    'https://example.com/hells-kitchen-review-supporting-cast-steals-show', { index: idx }), null);
});

// ---- BRO-3065: run-year filter, BWW sections, whole-run matching ----
const { showRunYears } = require('./cross-show-url.js');
const DATED = [
  { id: 'disaster-2016', title: 'Disaster!', openingDate: '2016-03-08', closingDate: '2016-05-08' },
  { id: 'white-rabbit-red-rabbit-west-end-2026', title: 'White Rabbit Red Rabbit', previewsStartDate: '2026-05-01', openingDate: '2026-05-10' },
  { id: 'white-rabbit-red-rabbit-2016', title: 'White Rabbit Red Rabbit', openingDate: '2016-03-07', closingDate: '2016-06-01' },
  { id: 'hells-kitchen-tour-2025', title: "Hell's Kitchen", openingDate: '2025-10-01' },
  { id: 'knockout-1979', title: 'Knockout', openingDate: '1979-05-06', closingDate: '1979-09-16', status: 'closed' },
  { id: 'oklahoma-2019', title: 'Oklahoma!', openingDate: '2019-04-07', closingDate: '2020-01-19' },
  { id: 'every-brilliant-thing-2026', title: 'Every Brilliant Thing', previewsStartDate: '2026-02-20', openingDate: '2026-03-12' },
  { id: 'schmigadoon-2026', title: 'Schmigadoon!', openingDate: '2026-04-20' },
  { id: 'music-city-off-broadway-2026', title: 'Music City Revue', previewsStartDate: '2026-09-01',
    priorRuns: [{ openingDate: '2024-03-03', closingDate: '2024-03-26' }] },
  { id: 'drunk-shakespeare-off-broadway-2022', title: 'Drunk Shakespeare Show', openingDate: '2022-01-01', status: 'closed' },
  { id: 'ballroom-1978', title: 'Ballroom', openingDate: '1978-12-14', closingDate: '1979-01-21' },
  { id: 'dancers-life-2025', title: 'The Dancers Life', openingDate: '2025-02-01' },
];
const dIndex = buildShowSlugIndex(DATED);
const dcheck = (showId, url, publishDate) => detectCrossShowUrlMismatch(showId, url, { index: dIndex, publishDate });

test('showRunYears: earliest start incl. priorRuns; endYear null without a closingDate', () => {
  assert.deepEqual(showRunYears(DATED.find(s => s.id === 'music-city-off-broadway-2026')), { startYear: 2024, endYear: null });
  assert.deepEqual(showRunYears(DATED.find(s => s.id === 'drunk-shakespeare-off-broadway-2022')), { startYear: 2022, endYear: null });
  assert.deepEqual(showRunYears(DATED.find(s => s.id === 'knockout-1979')), { startYear: 1979, endYear: 1979 });
  assert.deepEqual(showRunYears({ id: 'x', title: 'X' }), { startYear: null, endYear: null });
});

test('skips a show that opened years after the review, and falls through to a show that fits', () => {
  const url = 'https://www.vulture.com/2016/03/theater-white-rabbit-red-rabbit.html';
  const r = dcheck('disaster-2016', url, '2016-03-15');
  assert.ok(r, 'the 2016 production still matches');
  assert.equal(r.matchedShowId, 'white-rabbit-red-rabbit-2016');
  // no date: old behaviour (first index hit)
  assert.equal(dcheck('disaster-2016', url).matchedShowId, 'white-rabbit-red-rabbit-west-end-2026');
});

test('skips a show that closed decades before the review (any date format)', () => {
  const url = 'https://example.com/reviews/knockout-performance-hells-kitchen';
  assert.equal(dcheck('hells-kitchen-tour-2025', url, '2025-11-02'), null);
  assert.equal(dcheck('hells-kitchen-tour-2025', url, '2 November 2025'), null);
  assert.equal(dcheck('hells-kitchen-tour-2025', url, 'November 2nd, 2025'), null);
  // a review from the show's own era still flags
  assert.equal(dcheck('hells-kitchen-tour-2025', url, 'May 7, 1979').matchedShowId, 'knockout-1979');
});

test('priorRuns keep an earlier run in range; a real misfile with a matching date still flags', () => {
  const r = dcheck('schmigadoon-2026', 'https://example.com/reviews/music-city-revue-bedlam', '2024-03-10');
  assert.equal(r && r.matchedShowId, 'music-city-off-broadway-2026');
  const ebt = dcheck('schmigadoon-2026', 'https://www.nytimes.com/2026/03/12/theater/every-brilliant-thing-review.html', '2026-03-12');
  assert.equal(ebt && ebt.matchedShowId, 'every-brilliant-thing-2026');
});

test('a closed show without a closingDate is never treated as long gone', () => {
  const r = dcheck('schmigadoon-2026', 'https://example.com/drunk-shakespeare-show-review', '2026-05-01');
  assert.equal(r && r.matchedShowId, 'drunk-shakespeare-off-broadway-2022');
});

test('BroadwayWorld regional section word does not name the show', () => {
  const url = 'https://www.broadwayworld.com/oklahoma/article/Review-HELLS-KITCHEN-at-Civic-Center-20251101';
  assert.equal(dcheck('hells-kitchen-tour-2025', url), null);
  // the same word in the article slug itself still counts
  const r = dcheck('hells-kitchen-tour-2025', 'https://www.broadwayworld.com/article/Review-OKLAHOMA-at-Circle-in-the-Square-20190408');
  assert.equal(r && r.matchedShowId, 'oklahoma-2019');
  // non-BWW hosts keep the full path
  assert.equal(dcheck('hells-kitchen-tour-2025', 'https://example.com/oklahoma/article/x').matchedShowId, 'oklahoma-2019');
});

test('single-word titles match whole path words only (full slug and base title)', () => {
  assert.equal(dcheck('dancers-life-2025', 'https://example.com/reviews/ballroomdancing-at-the-dancers-life'), null);
  const r = dcheck('dancers-life-2025', 'https://example.com/reviews/ballroom-review', '1978-12-15');
  assert.equal(r && r.matchedShowId, 'ballroom-1978');
});

// BRO-6569: The Telegraph's Exit the King url drops the inner "the".
test('flags an inner-connector-dropped slug (exit-king) filed under The King and I', () => {
  const idx = buildShowSlugIndex([
    { id: 'the-king-and-i-west-end-2018', title: 'The King and I' },
    { id: 'exit-the-king-west-end-2018', title: 'Exit the King' },
    { id: 'bullets-over-broadway-2014', title: 'Bullets Over Broadway' },
    { id: 'guys-and-dolls-west-end-2016', title: 'Guys and Dolls' },
  ]);
  const url = 'https://www.telegraph.co.uk/theatre/what-to-see/exit-king-review-national-theatre-rhys-ifans-drives-chilling/';
  assert.equal(detectCrossShowUrlMismatch('the-king-and-i-west-end-2018', url, { index: idx })?.matchedShowId, 'exit-the-king-west-end-2018');
  assert.equal(detectCrossShowUrlMismatch('exit-the-king-west-end-2018', url, { index: idx }), null);
  assert.equal(detectCrossShowUrlMismatch('the-king-and-i-west-end-2018',
    'https://www.telegraph.co.uk/theatre/what-to-see/king-london-palladium-review-provocative-blend-bombast-subtlety/', { index: idx }), null);
  // An own word ("bullets") vouches even when another title's joined slug ("guys-dolls") is in the url.
  assert.equal(detectCrossShowUrlMismatch('bullets-over-broadway-2014',
    'https://www.thewrap.com/bullets-broadway-theater-review-woody-allen-takes-another-shot-gangland-guys-dolls/', { index: idx }), null);
});
