// Tests for production-level image matching (BRO-2242, BRO-4851). Fixtures are
// the real Mezzanine / Theatr cache entries and shows.json rows involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeVenueName, venuesMatch, pickMezzanineCandidate, theatrEligible, isRejectedImage, ibdbEligible, buildVenueCityIndex,
  canReuseArchivedFile,
  mayServeDiskImage,
  keepExistingImage, findRejectedSourcesInUse, recordFileSources, fileSourceUrls, imagePathOwner, isDownloadableSource, recordedSourceFor,
} = require('./image-source-match.js');

const at = (iso) => ({ __type: 'Date', iso });
const MEZZ_OEDIPUS = [
  { name: 'Oedipus', artUrl: 'https://x/oedipus old vic.png', theater: 'Old Vic Theatre', isBroadway: false, openedAt: at('2025-01-21T05:00:00.000Z'), ratingsCount: 190 },
  { name: 'Oedipus', artUrl: 'https://x/oedipus wyndhams.jpg', theater: "Wyndham's Theatre", isBroadway: false, openedAt: at('2024-10-04T04:00:00.000Z'), ratingsCount: 208 },
  { name: 'Oedipus', artUrl: 'https://x/oedipus sheen.jpg', theater: 'Sheen Center', isBroadway: false, openedAt: null, ratingsCount: 0 },
  { name: 'Oedipus', artUrl: 'https://x/oedipus studio 54.jpg', theater: 'Studio 54', isBroadway: true, openedAt: at('2025-10-30T04:00:00.000Z'), ratingsCount: 932 },
];
const oldVic = { id: 'oedipus-west-end-2025', title: 'Oedipus', category: 'west-end', venue: 'The Old Vic', previewsStartDate: '2025-01-21', openingDate: '2025-02-04', status: 'closed' };
const wyndhams = { id: 'oedipus-west-end-2024', title: 'Oedipus', category: 'west-end', venue: "Wyndham's Theatre", previewsStartDate: '2024-10-04', openingDate: '2024-10-15', status: 'closed' };
const broadway = { id: 'oedipus-2025', title: 'Oedipus', category: 'broadway', venue: 'Studio 54', openingDate: '2025-11-13', status: 'open' };

test('venue names normalize to the same tokens, and only exact token matches count', () => {
  assert.equal(normalizeVenueName('The Old Vic'), 'old vic');
  assert.ok(venuesMatch('The Old Vic', 'Old Vic Theatre'));
  assert.ok(venuesMatch('Noël Coward Theatre', 'Noel Coward'));
  assert.ok(!venuesMatch('Old Vic', 'Young Vic'));
  assert.ok(!venuesMatch('Apollo Theatre', 'Apollo Victoria Theatre'));
  assert.ok(!venuesMatch('', ''));
});

test('Mezzanine: each Oedipus row gets its own production, never Studio 54', () => {
  assert.equal(pickMezzanineCandidate(oldVic, MEZZ_OEDIPUS).candidate.theater, 'Old Vic Theatre');
  assert.equal(pickMezzanineCandidate(wyndhams, MEZZ_OEDIPUS).candidate.theater, "Wyndham's Theatre");
  assert.equal(pickMezzanineCandidate(broadway, MEZZ_OEDIPUS).candidate.theater, 'Studio 54');
});

test('Mezzanine: London row with no venue match drops Broadway and undated candidates', () => {
  const elsewhere = { ...oldVic, venue: 'Somewhere Else' };
  // Old Vic (2025-01-21) is nearest among dated non-Broadway rows.
  assert.equal(pickMezzanineCandidate(elsewhere, MEZZ_OEDIPUS).candidate.theater, 'Old Vic Theatre');
  const onlyNyc = MEZZ_OEDIPUS.filter(c => c.theater === 'Studio 54' || c.theater === 'Sheen Center');
  assert.equal(pickMezzanineCandidate(elsewhere, onlyNyc).candidate, null);
});

test('Mezzanine: previews date stands in for a missing opening date', () => {
  const noOpening = { ...oldVic, venue: 'Elsewhere', openingDate: null };
  assert.equal(pickMezzanineCandidate(noOpening, MEZZ_OEDIPUS).candidate.theater, 'Old Vic Theatre');
  const undated = { ...noOpening, previewsStartDate: null };
  assert.equal(pickMezzanineCandidate(undated, MEZZ_OEDIPUS).candidate, null); // several candidates, no date
});

test('Mezzanine: Earnest at the Noël Coward and White Rabbit at the Duchess match by venue', () => {
  const earnest = [
    { artUrl: 'https://x/earnest-nt.jpg', theater: 'National Theatre - Lyttelton', isBroadway: false, openedAt: at('2024-11-13T00:00:00Z') },
    { artUrl: 'https://x/earnest-nc.jpg', theater: 'Noël Coward Theatre', isBroadway: false, openedAt: at('2025-09-18T00:00:00Z') },
  ];
  const show = { title: 'The Importance of Being Earnest', category: 'west-end', venue: 'Noel Coward Theatre', previewsStartDate: '2025-09-18' };
  assert.equal(pickMezzanineCandidate(show, earnest).candidate.artUrl, 'https://x/earnest-nc.jpg');
  const wrr = [
    { artUrl: 'https://x/wrr-duchess.jpg', theater: 'Duchess Theatre', isBroadway: false, openedAt: at('2026-06-09T00:00:00Z') },
    { artUrl: 'https://x/wrr-soho.jpg', theater: '@sohoplace', isBroadway: false, openedAt: at('2024-10-01T00:00:00Z') },
  ];
  const wrr24 = { title: 'White Rabbit Red Rabbit', category: 'west-end', venue: 'Soho Place', previewsStartDate: '2024-10-01' };
  // "@sohoplace" vs "Soho Place" is not an exact token match, so the date decides.
  assert.equal(pickMezzanineCandidate(wrr24, wrr).candidate.artUrl, 'https://x/wrr-soho.jpg');
  assert.equal(pickMezzanineCandidate({ ...wrr24, venue: 'Duchess Theatre', previewsStartDate: '2026-06-09' }, wrr).candidate.artUrl, 'https://x/wrr-duchess.jpg');
});

test('Theatr: NYC-only, so London rows and closed rows with a same-title sibling are refused', () => {
  const othelloBway = { name: 'Othello', eventCategory: 'Broadway', venue: { name: 'Ethel Barrymore Theatre' } };
  const othelloWe = { id: 'othello-west-end-2025', title: 'Othello', category: 'west-end', venue: 'Theatre Royal Haymarket', status: 'closed' };
  const othello1970 = { id: 'othello-1970', title: 'Othello', category: 'broadway', venue: 'ANTA Theatre', status: 'closed' };
  const othello2025 = { id: 'othello-2025', title: 'Othello', category: 'broadway', venue: 'Ethel Barrymore Theatre', status: 'closed' };
  const all = [othelloWe, othello1970, othello2025];
  assert.equal(theatrEligible(othelloWe, othelloBway, all), false);
  assert.equal(theatrEligible(othello1970, othelloBway, all), false);
  assert.equal(theatrEligible(othello2025, othelloBway, all), true); // own venue
  const solo = { id: 'solo-2026', title: 'Solo Show', category: 'off-broadway', venue: 'Somewhere', status: 'open' };
  assert.equal(theatrEligible(solo, { venue: { name: 'Elsewhere' } }, [solo]), true);
});

test('IBDB is Broadway-only', () => {
  assert.equal(ibdbEligible({ category: 'west-end' }), false);
  assert.equal(ibdbEligible({ category: 'off-west-end' }), false);
  assert.equal(ibdbEligible({ category: 'broadway' }), true);
});

test('rejectedImageUrls blocks a re-fetch of the same source, query string ignored', () => {
  const show = { rejectedImageUrls: ['https://cdn/theatr/godot-poster.jpg'] };
  assert.equal(isRejectedImage({ poster: 'https://cdn/theatr/godot-poster.jpg?w=720' }, show), true);
  assert.equal(isRejectedImage({ poster: 'https://cdn/other.jpg' }, show), false);
  assert.equal(isRejectedImage({ poster: 'https://cdn/theatr/godot-poster.jpg' }, {}), false);
});

test('Mezzanine: venue city from shows.json keeps each row in its own city', () => {
  const index = buildVenueCityIndex([
    { venue: 'Theatre Royal Haymarket', category: 'west-end' },
    { venue: 'Studio 54', category: 'broadway' },
    { venue: 'Lyceum Theatre', category: 'broadway' },
    { venue: 'Lyceum Theatre', category: 'west-end' },
  ]);
  assert.equal(index.get('royal haymarket'), 'london');
  assert.equal(index.get('lyceum'), undefined); // both cities: neutral
  const godot = [
    { artUrl: 'https://x/godot-haymarket.jpg', theater: 'Theatre Royal Haymarket', isBroadway: false, openedAt: at('2009-04-29T00:00:00Z') },
    { artUrl: 'https://x/godot-studio54.jpg', theater: 'Studio 54', isBroadway: true, openedAt: at('2009-04-30T00:00:00Z') },
  ];
  const row = { title: 'Waiting for Godot', category: 'broadway', venue: 'Some Renamed House', openingDate: '2009-04-30' };
  assert.equal(pickMezzanineCandidate(row, godot, index).candidate.theater, 'Studio 54');
  // Unreliable isBroadway flag: the 2002 Martin Beck row is false but must still win for Broadway.
  const mancha = [
    { artUrl: 'https://x/mancha-92.jpg', theater: 'Marquis Theatre', isBroadway: true, openedAt: at('1992-03-31T00:00:00Z') },
    { artUrl: 'https://x/mancha-02.jpg', theater: 'Martin Beck Theatre', isBroadway: false, openedAt: at('2002-11-23T00:00:00Z') },
  ];
  const m02 = { title: 'Man of La Mancha', category: 'broadway', venue: 'Al Hirschfeld Theatre', openingDate: '2002-12-05', previewsStartDate: '2002-11-23' };
  assert.equal(pickMezzanineCandidate(m02, mancha, index).candidate.theater, 'Martin Beck Theatre');
});

// The real Mezzanine cache entries for "Chicago" (2026-10-08). The 1975 row
// opened at the 46th Street Theatre, now the Richard Rodgers, where the 1996
// revival also opened; every other entry is undated.
const MEZZ_CHICAGO = [
  { artUrl: 'https://x/chicago red cambridge.jpg', theater: 'Cambridge Theatre', isBroadway: false, openedAt: null },
  { artUrl: 'https://x/chicago red garrick.jpg', theater: 'Garrick Theatre', isBroadway: false, openedAt: null },
  { artUrl: 'https://x/chicago.jpg', theater: 'Richard Rodgers Theatre', isBroadway: true, openedAt: at('1996-10-23T05:00:00.000Z') },
  { artUrl: 'https://x/chicago red phoenix.jpg', theater: 'Phoenix Theatre', isBroadway: false, openedAt: null },
  { artUrl: 'https://x/chicago white.jpg', theater: 'Sam S. Shubert Theatre', isBroadway: true, openedAt: null },
  { artUrl: 'https://x/chicago red adelphi.jpg', theater: 'Adelphi Theatre', isBroadway: false, openedAt: at('1997-10-28T00:00:00.000Z') },
  { artUrl: 'https://x/chicago 2023.jpg', theater: 'Ambassador Theatre', isBroadway: true, openedAt: null },
];

test('Mezzanine: a same-house candidate from another decade is not this production', () => {
  const c75 = { id: 'chicago-1975', title: 'Chicago', category: 'broadway', venue: 'Richard Rodgers Theatre', openingDate: '1975-06-03' };
  const r75 = pickMezzanineCandidate(c75, MEZZ_CHICAGO);
  assert.equal(r75.candidate, null, r75.reason);
  // The 1996 revival at the same house still gets its own art.
  const c96 = { id: 'chicago-1996', title: 'Chicago', category: 'broadway', venue: 'Richard Rodgers Theatre', openingDate: '1996-11-14' };
  assert.equal(pickMezzanineCandidate(c96, MEZZ_CHICAGO).candidate.artUrl, 'https://x/chicago.jpg');
  // A run that reopened at its own house after the pandemic is the same production.
  const north = { title: 'Girl from the North Country', category: 'broadway', venue: 'Belasco Theatre', openingDate: '2022-04-29' };
  const northCands = [{ artUrl: 'https://x/gftnc.jpg', theater: 'Belasco Theatre', isBroadway: true, openedAt: at('2020-02-07T05:00:00.000Z') }];
  assert.equal(pickMezzanineCandidate(north, northCands).candidate.artUrl, 'https://x/gftnc.jpg');
});

test('Mezzanine: a closed show over 2 years old takes an undated candidate only at its own venue', () => {
  const now = { nowMs: Date.parse('2026-10-08') };
  const row = { title: 'Chicago', category: 'broadway', status: 'closed', venue: 'Somewhere Else', openingDate: '2010-01-01' };
  const undatedOnly = MEZZ_CHICAGO.filter((c) => !c.openedAt);
  const r = pickMezzanineCandidate(row, undatedOnly, undefined, now);
  assert.equal(r.candidate, null);
  assert.match(r.reason, /undated/);
  // A long run still playing (Perfect Crime, 1987-) keeps its current art.
  assert.ok(pickMezzanineCandidate({ ...row, status: 'open' }, undatedOnly, undefined, now).candidate);
  // At its own venue an undated record is usually the long run itself
  // (chicago-1996 at the Ambassador, The Lion King at the Minskoff).
  const atAmbassador = { ...row, venue: 'Ambassador Theatre' };
  assert.equal(pickMezzanineCandidate(atAmbassador, MEZZ_CHICAGO, undefined, now).candidate.artUrl, 'https://x/chicago 2023.jpg');
  // A current show keeps undated candidates anywhere: Mezzanine's newest
  // listings carry no date, and their venue names often differ from ours.
  const offBway = { title: 'Isla', category: 'off-broadway', venue: 'WP Theater', openingDate: '2026-08-08' };
  const isla = [{ artUrl: 'https://x/isla.jpg', theater: 'WP Theater (McGinn/Cazale Theatre)', isBroadway: false, openedAt: null }];
  assert.equal(pickMezzanineCandidate(offBway, isla, undefined, now).candidate.artUrl, 'https://x/isla.jpg');
});

test('archive: an existing file is reused only when it came from the same source URL', () => {
  const art = 'https://www.theaterdiary.com/parse/files/x/chicago.jpg';
  const old = 'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/6/medium_WHITNEY.jpg';
  // The 2026-10-08 bug: new art picked, same file name on disk, old art kept.
  assert.equal(canReuseArchivedFile({ recordedSource: old, incomingUrl: art, fileExists: true, force: false }), false);
  assert.equal(canReuseArchivedFile({ recordedSource: art, incomingUrl: art, fileExists: true, force: false }), true);
  assert.equal(canReuseArchivedFile({ recordedSource: art, incomingUrl: `${art}?fm=webp&q=90`, fileExists: true, force: false }), true);
  // No record of where the file came from: download rather than trust it.
  assert.equal(canReuseArchivedFile({ recordedSource: undefined, incomingUrl: art, fileExists: true, force: false }), false);
  assert.equal(canReuseArchivedFile({ recordedSource: art, incomingUrl: art, fileExists: false, force: false }), false);
  assert.equal(canReuseArchivedFile({ recordedSource: art, incomingUrl: art, fileExists: true, force: true }), false);
});

test('page builder: a disk hero whose recorded source was rejected is not served', () => {
  const theatr = 'https://d2rawotm8xdpob.cloudfront.net/v0/b/theatr-app.appspot.com/o/shows/othello.jpg';
  const row = { id: 'othello-1970', rejectedImageUrls: [`${theatr}?alt=media`] };
  // othello-1970 kept the 2025 Denzel Washington banner this way.
  assert.equal(mayServeDiskImage(row, theatr), false);
  assert.equal(mayServeDiskImage(row, 'https://assets.playbill.com/playbill-covers/othello-1970.jpg'), true);
  // No record, or nothing rejected: served as before.
  assert.equal(mayServeDiskImage(row, undefined), true);
  assert.equal(mayServeDiskImage({ id: 'x' }, theatr), true);
});

// BRO-4901: real rows. funny-girl-2002 still points at a Theatr upload it rejected;
// waiting-for-godot-2013 was fixed by hand and now records a manual: source.
const FG_REJECTED = 'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/6868/medium_1662483958-TT_480x720.jpg';
const funnyGirl = {
  id: 'funny-girl-2002',
  images: { poster: '/images/shows/funny-girl-2002/poster.jpg', thumbnail: '/images/shows/funny-girl-2002/thumbnail.jpg', hero: null },
  rejectedImageUrls: [FG_REJECTED],
};
const godot = {
  id: 'waiting-for-godot-2013',
  images: { poster: '/images/shows/waiting-for-godot-2013/poster.jpg', thumbnail: '/images/shows/waiting-for-godot-2013/thumbnail.jpg' },
  rejectedImageUrls: ['https://d2rawotm8xdpob.cloudfront.net/v0/b/theatr-app.appspot.com/o/shows/godot.png'],
};
const SOURCES = {
  'funny-girl-2002': { poster: FG_REJECTED, thumbnail: FG_REJECTED, hero: null },
  'waiting-for-godot-2013': { poster: 'manual:original-run art (checked by eye, BRO-4901)', thumbnail: 'manual:original-run art (checked by eye, BRO-4901)' },
};

test('imagePathOwner and isDownloadableSource', () => {
  assert.equal(imagePathOwner('/images/shows/funny-girl-2002/poster.jpg'), 'funny-girl-2002');
  assert.equal(imagePathOwner('https://cdn/x.jpg'), null);
  assert.equal(imagePathOwner(null), null);
  assert.ok(isDownloadableSource(FG_REJECTED));
  assert.ok(!isDownloadableSource('manual:hand-set'));
  assert.ok(!isDownloadableSource(null));
});

test('keepExistingImage drops a file whose recorded source is rejected and keeps the rest', () => {
  assert.equal(keepExistingImage(funnyGirl, 'poster', SOURCES), false);
  assert.equal(keepExistingImage(godot, 'poster', SOURCES), true, 'manual: source is kept');
  assert.equal(keepExistingImage(funnyGirl, 'hero', SOURCES), false, 'no local file to keep');
  assert.equal(keepExistingImage({ ...godot, id: 'new-row' }, 'poster', {}), true, 'unknown source is kept');
  assert.equal(keepExistingImage({ id: 'x', images: { poster: 'https://cdn/p.jpg' } }, 'poster', SOURCES), false, 'remote URL is not a kept file');
});

test('recordedSourceFor reads the map under the file owner, so cross-show paths use the owner entry', () => {
  const borrower = { id: 'funny-girl-tour', images: { poster: '/images/shows/funny-girl-2002/poster.jpg' }, rejectedImageUrls: [FG_REJECTED] };
  assert.equal(recordedSourceFor(borrower, 'poster', SOURCES), FG_REJECTED);
  assert.equal(recordedSourceFor(funnyGirl, 'hero', SOURCES), null);
});

test('findRejectedSourcesInUse lists only in-use local fields mapped to a rejected URL', () => {
  const rows = findRejectedSourcesInUse([funnyGirl, godot, { id: 'no-images' }], SOURCES);
  assert.deepEqual(rows.map(r => `${r.id}.${r.format}`), ['funny-girl-2002.poster', 'funny-girl-2002.thumbnail']);
  const cleared = { ...funnyGirl, images: { poster: null, thumbnail: null } };
  assert.deepEqual(findRejectedSourcesInUse([cleared], SOURCES), []);
});

test('recordFileSources writes only entries whose path is still the field value', () => {
  const sources = {};
  const images = {
    poster: '/images/shows/godot-west-end/poster.jpg',
    thumbnail: '/images/shows/godot-west-end/thumbnail.jpg',
    _fileSources: {
      poster: { path: '/images/shows/godot-west-end/poster.jpg', source: 'https://cdn/a.jpg' },
      thumbnail: { path: '/images/shows/godot-west-end/thumbnail.png', source: 'https://cdn/b.jpg' },
      hero: { path: '/images/shows/godot-west-end/hero.jpg', source: 'https://cdn/c.jpg' },
    },
  };
  assert.deepEqual(fileSourceUrls(images), { poster: 'https://cdn/a.jpg', thumbnail: 'https://cdn/b.jpg', hero: 'https://cdn/c.jpg' });
  assert.deepEqual(recordFileSources(sources, images), ['poster']);
  assert.deepEqual(sources, { 'godot-west-end': { poster: 'https://cdn/a.jpg' } });
  assert.deepEqual(recordFileSources(null, images), []);
});
