/**
 * Tests for scripts/lib/shared-image-source.js (BRO-4996)
 * Run: node --test scripts/lib/shared-image-source.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  sourceBase, isPlaceholderSource, mayShareSource, buildSourceIndex, addToSourceIndex,
  sourceConflict, stripConflictingSources, findSharedSources, showScoreArtEligible, todaytixIdOwner, titleMatchesSlug,
} = require('./shared-image-source.js');

const SS_OLD = 'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/841/medium_Hughie180.jpg';
const SS_NEW = 'https://dalyklerwhmui.cloudfront.net/uploads/show/poster_image/841/medium_Hughie180.jpg?v=2';
const CHICKS = 'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/62/medium_1711643050-chicks_in_heaven_poster_graphic__2_.jpg';
const TT = 'https://images.ctfassets.net/6pezt69ih962/abc/def/hughie.jpg';

const shows = [
  { id: 'hughie-1996', title: 'Hughie', openingDate: '1996-08-22' },
  { id: 'hughie-2016', title: 'Hughie', openingDate: '2016-02-25' },
  { id: 'illinoise-2024', title: 'Illinoise', openingDate: '2024-04-24' },
  { id: 'hells-kitchen-2024', title: "Hell's Kitchen", openingDate: '2024-04-20' },
  { id: 'show-a-off-broadway-2025', title: 'Show A', openingDate: '2025-01-01', transferredTo: 'show-a-2026' },
  { id: 'show-a-2026', title: 'Show A', openingDate: '2026-01-01', transferOf: 'show-a-off-broadway-2025' },
  { id: 'the-pass-off-broadway-2026', title: 'The Pass' },
  { id: 'the-pass-off-west-end-2026', title: 'The Pass' },
  { id: 'rockers-off-west-end-2026', title: 'Rockers' },
];

test('sourceBase drops the query and the Show Score CloudFront host', () => {
  assert.equal(sourceBase(SS_OLD), sourceBase(SS_NEW));
  assert.notEqual(sourceBase(SS_OLD), sourceBase(SS_OLD.replace('841', '842')));
});

test('the Chicks in Heaven promo is a placeholder on either host, with a query', () => {
  assert.equal(isPlaceholderSource(CHICKS), true);
  assert.equal(isPlaceholderSource(CHICKS.replace('d4ov6iqsvotvt', 'dalyklerwhmui') + '?1'), true);
  assert.equal(isPlaceholderSource(SS_OLD), false);
  assert.equal(isPlaceholderSource('manual:checked by eye'), false);
});

test('linked transfers and listed same-production pairs may share; unrelated rows may not', () => {
  assert.equal(mayShareSource('show-a-2026', 'show-a-off-broadway-2025', shows), true);
  assert.equal(mayShareSource('the-pass-off-broadway-2026', 'the-pass-off-west-end-2026', shows), true, 'ALLOWED_SHARED_IMAGES pair');
  assert.equal(mayShareSource('hughie-1996', 'hughie-2016', shows), false);
  assert.equal(mayShareSource('illinoise-2024', 'hells-kitchen-2024', shows), false);
  const allowlist = { 'illinoise-2024': { owner: 'hells-kitchen-2024' } };
  assert.equal(mayShareSource('illinoise-2024', 'hells-kitchen-2024', shows, { allowlist }), true);
});

test('a source another unrelated show records is refused (the Hughie 1996 case)', () => {
  const index = buildSourceIndex({ 'hughie-2016': { poster: SS_OLD, thumbnail: 'manual:x' } }, shows);
  assert.deepEqual(sourceConflict('hughie-1996', SS_NEW, index, shows), { reason: 'owned', owner: 'hughie-2016' });
  assert.equal(sourceConflict('hughie-2016', SS_NEW, index, shows), null, 'its own source is fine');
  assert.equal(sourceConflict('hughie-1996', TT, index, shows), null, 'an unrecorded source is fine');
  assert.equal(sourceConflict('hughie-1996', '/images/shows/hughie-1996/poster.jpg', index, shows), null, 'local paths are not sources');
});

test('retired ids left in image-sources.json do not own anything', () => {
  const index = buildSourceIndex({ 'gone-2001': { poster: TT } }, shows);
  assert.equal(sourceConflict('hughie-1996', TT, index, shows), null);
});

test('a row that rejects a source it records does not own it (frees it for the right row)', () => {
  const sources = { 'illinoise-2024': { poster: TT }, 'hells-kitchen-2024': { poster: TT } };
  const before = buildSourceIndex(sources, shows);
  assert.equal(sourceConflict('hells-kitchen-2024', TT, before, shows).owner, 'illinoise-2024');
  const fixed = shows.map((s) => (s.id === 'illinoise-2024' ? { ...s, rejectedImageUrls: [TT + '?w=480'] } : s));
  assert.equal(sourceConflict('hells-kitchen-2024', TT, buildSourceIndex(sources, fixed), fixed), null);
  assert.deepEqual(findSharedSources(sources, fixed), []);
});

test('a linked production may take its transfer\'s recorded source', () => {
  const index = buildSourceIndex({ 'show-a-off-broadway-2025': { poster: TT } });
  assert.equal(sourceConflict('show-a-2026', TT, index, shows), null);
});

test('a placeholder is refused even when nobody records it', () => {
  assert.deepEqual(sourceConflict('rockers-off-west-end-2026', CHICKS, new Map(), shows), { reason: 'placeholder' });
});

test('stripConflictingSources nulls only the conflicting formats and leaves the input alone', () => {
  const index = buildSourceIndex({ 'hells-kitchen-2024': { hero: TT } });
  const input = { poster: SS_OLD, thumbnail: CHICKS, hero: TT };
  const { images, dropped } = stripConflictingSources('illinoise-2024', input, index, shows);
  assert.deepEqual(images, { poster: SS_OLD, thumbnail: null, hero: null });
  assert.deepEqual(dropped.map((d) => [d.format, d.reason]), [['thumbnail', 'placeholder'], ['hero', 'owned']]);
  assert.equal(input.hero, TT);
});

test('addToSourceIndex makes a source this run accepted owned for later shows', () => {
  const index = new Map();
  addToSourceIndex(index, 'hughie-2016', SS_OLD);
  addToSourceIndex(index, 'hughie-2016', 'manual:note');
  assert.equal(index.size, 1);
  assert.equal(sourceConflict('hughie-1996', SS_NEW, index, shows).owner, 'hughie-2016');
});

test('findSharedSources lists unrelated sharing and placeholders, not linked or listed pairs', () => {
  const sources = {
    'hughie-1996': { poster: SS_NEW },
    'hughie-2016': { poster: SS_OLD },
    'show-a-2026': { poster: TT },
    'show-a-off-broadway-2025': { poster: TT },
    'the-pass-off-broadway-2026': { poster: 'https://x.test/pass.jpg' },
    'the-pass-off-west-end-2026': { poster: 'https://x.test/pass.jpg' },
    'rockers-off-west-end-2026': { thumbnail: CHICKS },
  };
  const found = findSharedSources(sources, shows);
  assert.deepEqual(found.map((f) => [f.ids, f.placeholder]), [
    [['hughie-1996', 'hughie-2016'], false],
    [['rockers-off-west-end-2026'], true],
  ]);
});

test('showScoreArtEligible: only the newest same-title production on one Show Score page', () => {
  const page = 'https://www.show-score.com/broadway-shows/hughie';
  const resolve = () => page;
  const [h96, h16] = shows;
  assert.equal(showScoreArtEligible(h96, page, shows, resolve), false);
  assert.equal(showScoreArtEligible(h16, page, shows, resolve), true);
  assert.equal(showScoreArtEligible(h96, page, shows, () => 'https://www.show-score.com/other'), true, 'different pages do not compete');
  const undated = { id: 'hughie-x', title: 'Hughie' };
  assert.equal(showScoreArtEligible(undated, page, [...shows, undated], resolve), false, 'an undated row loses to a dated one');
});

test('titleMatchesSlug: half the title words, "on broadway" and "the musical" ignored', () => {
  assert.equal(titleMatchesSlug('The Lion King', 'the-lion-king-on-broadway'), true);
  assert.equal(titleMatchesSlug('The Caretaker', 'the-lion-king-on-broadway'), false);
  assert.equal(titleMatchesSlug('Kinky Boots: The Musical', 'kinky-boots'), true);
});

test('todaytixIdOwner: the row the cached slug names owns the id, not whoever cached it', () => {
  const rows = [
    { id: 'the-lion-king-1997', title: 'The Lion King', openingDate: '1997-11-13' },
    { id: 'the-caretaker-2003', title: 'The Caretaker', openingDate: '2003-10-30' },
    ...shows,
  ];
  const cache = { 'the-lion-king-1997': { id: 42, slug: null }, 'the-caretaker-2003': { id: 42, slug: 'the-lion-king-on-broadway' } };
  assert.equal(todaytixIdOwner(rows[0], 42, cache, rows), null, 'the Lion King keeps its page');
  assert.equal(todaytixIdOwner(rows[1], 42, cache, rows), 'the-lion-king-1997');
});

test('todaytixIdOwner: same title in one city, the newest production owns the page', () => {
  const cache = { 'hughie-1996': { id: 7 }, 'hughie-2016': { id: 7 } };
  const [h96, h16] = shows;
  assert.equal(todaytixIdOwner(h96, 7, cache, shows), 'hughie-2016');
  assert.equal(todaytixIdOwner(h16, 7, cache, shows), null);
});

test('todaytixIdOwner: unsure cases, linked rows and retired rows block nobody', () => {
  const cache = {
    'hells-kitchen-2024': { id: 25598 },
    'show-a-off-broadway-2025': { id: 111 },
    'gone-2001': { id: 999 },
  };
  const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
  assert.equal(todaytixIdOwner(byId['illinoise-2024'], 25598, cache, shows), null, 'no slug, different titles: left to the image guard');
  assert.equal(todaytixIdOwner(byId['show-a-2026'], 111, cache, shows), null, 'a linked transfer may share it');
  assert.equal(todaytixIdOwner(byId['illinoise-2024'], 999, cache, shows), null, 'a retired row owns nothing');
  assert.equal(todaytixIdOwner(byId['illinoise-2024'], null, cache, shows), null);
});

test('todaytixIdOwner: a subtitle is the same title; "-on-broadway" pages belong to the Broadway row', () => {
  const rows = [
    { id: 'cats-1982', title: 'Cats', openingDate: '1982-10-07', category: 'broadway' },
    { id: 'cats-the-jellicle-ball-2026', title: 'Cats: The Jellicle Ball', openingDate: '2026-04-07', category: 'broadway' },
    { id: 'othello-2025', title: 'Othello', openingDate: '2025-03-23', category: 'broadway' },
    { id: 'othello-off-broadway-2026', title: 'Othello', openingDate: '2026-02-01', category: 'off-broadway' },
  ];
  const cache = { 'cats-1982': { id: 1, slug: 'cats' }, 'cats-the-jellicle-ball-2026': { id: 1 }, 'othello-2025': { id: 2, slug: 'othello-on-broadway' }, 'othello-off-broadway-2026': { id: 2, slug: 'othello-on-broadway' } };
  assert.equal(todaytixIdOwner(rows[1], 1, cache, rows), null, 'the current Jellicle Ball keeps it');
  assert.equal(todaytixIdOwner(rows[0], 1, cache, rows), 'cats-the-jellicle-ball-2026');
  assert.equal(todaytixIdOwner(rows[2], 2, cache, rows), null);
  assert.equal(todaytixIdOwner(rows[3], 2, cache, rows), 'othello-2025');
});

test('todaytixIdOwner: an undated announced row is as new as its id year; "Doll\'s" matches a dolls slug', () => {
  const rows = [
    { id: 'dreamgirls-2001', title: 'Dreamgirls', openingDate: '2001-09-24', category: 'broadway' },
    { id: 'dreamgirls-2026', title: 'Dreamgirls', category: 'broadway' },
    { id: 'a-dolls-house-2023', title: "A Doll's House", openingDate: '2023-03-09', category: 'broadway' },
    { id: 'a-dolls-house-play-off-west-end-2026', title: 'A Dolls House Play', category: 'off-west-end' },
  ];
  const cache = { 'dreamgirls-2001': { id: 5 }, 'dreamgirls-2026': { id: 5 }, 'a-dolls-house-2023': { id: 6, slug: 'a-dolls-house-on-broadway' }, 'a-dolls-house-play-off-west-end-2026': { id: 6, slug: 'a-dolls-house-on-broadway' } };
  assert.equal(todaytixIdOwner(rows[1], 5, cache, rows), null);
  assert.equal(todaytixIdOwner(rows[0], 5, cache, rows), 'dreamgirls-2026');
  assert.equal(todaytixIdOwner(rows[2], 6, cache, rows), null);
  assert.equal(todaytixIdOwner(rows[3], 6, cache, rows), 'a-dolls-house-2023');
});

test('todaytixIdOwner: a numbered sequel is another show; a running row keeps the page', () => {
  const rows = [
    { id: 'prada-west-end-2024', title: 'The Devil Wears Prada', openingDate: '2024-12-02', status: 'open', category: 'west-end' },
    { id: 'prada-2-off-west-end-2026', title: 'Devil Wears Prada 2', category: 'off-west-end' },
    { id: 'death-note-west-end-2026', title: 'Death Note: The Musical', openingDate: '2026-08-11', status: 'open', category: 'off-west-end' },
    { id: 'death-note-off-west-end-2027', title: 'Death Note The Musical', previewsStartDate: '2027-03-23', status: 'upcoming', category: 'off-west-end' },
  ];
  const cache = { 'prada-west-end-2024': { id: 1 }, 'prada-2-off-west-end-2026': { id: 1 }, 'death-note-west-end-2026': { id: 2 }, 'death-note-off-west-end-2027': { id: 2 } };
  assert.equal(todaytixIdOwner(rows[0], 1, cache, rows), null, 'no slug, different shows: left to the image guard');
  assert.equal(todaytixIdOwner(rows[2], 2, cache, rows), null);
  assert.equal(todaytixIdOwner(rows[3], 2, cache, rows), 'death-note-west-end-2026');
});

test('todaytixIdOwner: a one-word title is related only as a main title before a subtitle', () => {
  const rows = [
    { id: 'player-kings-2024', title: 'Player Kings', openingDate: '2024-04-11', category: 'west-end' },
    { id: 'the-player-2026', title: 'The Player', openingDate: '2026-05-01', category: 'west-end' },
    { id: 'cats-2016', title: 'Cats', openingDate: '2016-07-31', category: 'broadway' },
    { id: 'cats-jellicle-2026', title: 'Cats: The Jellicle Ball', openingDate: '2026-04-07', category: 'broadway' },
  ];
  const cache = { 'player-kings-2024': { id: 1 }, 'the-player-2026': { id: 1 }, 'cats-2016': { id: 2 }, 'cats-jellicle-2026': { id: 2 } };
  assert.equal(todaytixIdOwner(rows[0], 1, cache, rows), null, 'Player Kings is not The Player: left to the image guard');
  assert.equal(todaytixIdOwner(rows[2], 2, cache, rows), 'cats-jellicle-2026');
});

test('titleMatchesSlug: repeated title words count once', () => {
  assert.equal(titleMatchesSlug('Big Man, Little Man', 'the-music-man'), false);
  assert.equal(titleMatchesSlug('The Ocean at the End of the Lane', 'the-end'), false);
});
