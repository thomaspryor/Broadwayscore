// Tests for production-level image matching (BRO-2242, BRO-4851). Fixtures are
// the real Mezzanine / Theatr cache entries and shows.json rows involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeVenueName, venuesMatch, pickMezzanineCandidate, theatrEligible, isRejectedImage, ibdbEligible, buildVenueCityIndex,
  canReuseArchivedFile,
  mayServeDiskImage, thumbnailFallbackAction,
  keepExistingImage, findRejectedSourcesInUse, wrongEraTodayTixReason, refusedSourceReason, missingFileRedownload, freshSourceFor, recordFileSources, fileSourceUrls, imagePathOwner, isDownloadableSource, recordedSourceFor, localImageAction,
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

// BRO-7846: the BRO-5089 sweep cleared follies-2011's TodayTix poster and
// thumbnail (NT Live Follies, another production) and left the hero from the
// same catalogue match. Rows that closed before TodayTix sold tickets carried
// TodayTix heroes of unrelated shows (Grease 2007: an anti-vaping campaign).
const TT = (name) => `https://images.ctfassets.net/6pezt69ih962/abc/def/${name}.png?fm=webp&q=90`;
const follies = {
  id: 'follies-2011', status: 'closed', closingDate: '2012-01-22',
  images: { poster: null, thumbnail: null, hero: '/images/shows/follies-2011/hero.webp' },
  rejectedImageUrls: [TT('TodayTix_NTLive_Follies_480x720')],
};
const company = {
  id: 'company-2021', status: 'closed', closingDate: '2022-07-31',
  images: { poster: null, thumbnail: null, hero: '/images/shows/company-2021/hero.webp' },
  rejectedImageUrls: [TT('company_poster')],
};
const TT_SOURCES = {
  'follies-2011': { hero: TT('TodayTix_NTLive_Follies_1600x1200') },
  'company-2021': { hero: TT('header') },
  'once-upon-a-mattress-2024': { poster: TT('OUAM-KeyArt'), hero: null },
};

test('findRejectedSourcesInUse lists TodayTix art that cannot be the row\'s own production', () => {
  const rows = findRejectedSourcesInUse([follies, company], TT_SOURCES);
  assert.deepEqual(rows.map(r => `${r.id}.${r.format}`), ['follies-2011.hero', 'company-2021.hero']);
  assert.match(rows[0].why, /closed before TodayTix/);
  assert.match(rows[1].why, /poster was rejected/);
  // A row that kept its own poster rejected one stray file, not the match.
  const ouam = { id: 'once-upon-a-mattress-2024', status: 'closed', closingDate: '2024-11-30',
    images: { poster: '/images/shows/once-upon-a-mattress-2024/poster.webp' }, rejectedImageUrls: [TT('heart-portal-banner')] };
  assert.deepEqual(findRejectedSourcesInUse([ouam], TT_SOURCES), []);
  // Cleared hero: nothing to report.
  assert.deepEqual(findRejectedSourcesInUse([{ ...follies, images: { hero: null } }], TT_SOURCES), []);
});

test('findRejectedSourcesInUse judges a borrowed file by the row that owns it', () => {
  // legally-blonde-tour-2022 served the 2007 row's wrong TodayTix hero. The
  // tour itself is recent and rejected nothing, so only the owner shows it.
  const lb2007 = { id: 'legally-blonde-2007', status: 'closed', closingDate: '2008-10-19',
    images: { hero: null }, rejectedImageUrls: [] };
  const tour = { id: 'legally-blonde-tour-2022', status: 'closed', closingDate: '2023-06-30',
    images: { hero: '/images/shows/legally-blonde-2007/hero.webp' }, rejectedImageUrls: [] };
  const sources = { 'legally-blonde-2007': { hero: TT('LB-header') } };
  const rows = findRejectedSourcesInUse([lb2007, tour], sources);
  assert.deepEqual(rows.map(r => `${r.id}.${r.format}`), ['legally-blonde-tour-2022.hero']);
  assert.match(rows[0].why, /closed before TodayTix/);
  // Owner missing from the list: judged by the borrower alone (no crash).
  assert.deepEqual(findRejectedSourcesInUse([tour], sources), []);
});

test('wrongEraTodayTixReason uses the London launch date for West End rows', () => {
  // handbagged-west-end-2014 closed Aug 2014, before TodayTix sold West End
  // tickets (June 2015); its TodayTix art was the 2019 Kiln revival's.
  const we2014 = { id: 'handbagged-west-end-2014', market: 'west-end', status: 'closed', closingDate: '2014-08-02' };
  assert.match(wrongEraTodayTixReason(we2014, TT('Handbagged')), /closed before TodayTix/);
  assert.equal(wrongEraTodayTixReason({ ...we2014, closingDate: '2015-09-01' }, TT('x')), null);
  // The same date on Broadway is after TodayTix's New York launch: kept.
  assert.equal(wrongEraTodayTixReason({ ...we2014, market: 'broadway' }, TT('x')), null);
});

test('wrongEraTodayTixReason keeps running rows, post-2013 rows with no rejection, and non-TodayTix sources', () => {
  const running = { id: 'x', status: 'open', closingDate: null, rejectedImageUrls: [TT('old')] };
  assert.equal(wrongEraTodayTixReason(running, TT('new')), null, 'a running row may take by-id catalogue art');
  const closed2019 = { id: 'y', status: 'closed', closingDate: '2019-06-30' };
  assert.equal(wrongEraTodayTixReason(closed2019, TT('art')), null, 'art taken during the run is the row\'s own');
  assert.equal(wrongEraTodayTixReason(follies, 'manual:checked by eye'), null);
  assert.equal(wrongEraTodayTixReason(follies, 'https://www.theaterdiary.com/x.jpg'), null);
  assert.ok(wrongEraTodayTixReason({ ...follies, rejectedImageUrls: [] }, TT('x')), 'closed in 2012: always another production');
  // An image-search hit recorded as a todaytix.com show page is the catalogue too (the-effect-west-end-2012).
  assert.ok(wrongEraTodayTixReason(follies, 'google-images:https://www.todaytix.com/london/shows/33425-the-effect'));
  assert.equal(wrongEraTodayTixReason(follies, 'google-images:https://www.broadway.com/shows/follies/'), null);
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

// BRO-4884: the poster -> thumbnail fallback reused a leftover thumbnail file
// whose source the row had rejected (get-up-stand-up's Bob Marley concert photo).
test('thumbnailFallbackAction copies the poster over a rejected leftover thumbnail', () => {
  const rejected = 'google-images:https://www.broadway.com/buzz/198456/bob-marley-musical-get-up-stand-up-to-open-in-londons-west-end-in-2021/';
  const row = { id: 'get-up-stand-up-the-bob-marley-story-west-end-2021', rejectedImageUrls: [rejected] };
  assert.equal(thumbnailFallbackAction(row, { targetExists: true, targetRecordedSource: rejected }), 'copy');
  // No file on disk: always copy.
  assert.equal(thumbnailFallbackAction(row, { targetExists: false, targetRecordedSource: null }), 'copy');
  // A leftover file nobody rejected (or of unknown source) is reused as before.
  assert.equal(thumbnailFallbackAction(row, { targetExists: true, targetRecordedSource: 'google-images:https://example.com/other.jpg' }), 'reuse');
  assert.equal(thumbnailFallbackAction({ id: 'x' }, { targetExists: true, targetRecordedSource: rejected }), 'reuse');
  assert.equal(thumbnailFallbackAction(row, { targetExists: true, targetRecordedSource: undefined }), 'reuse');
});

// BRO-7846 follow-up: the wrong-era rule lived only in the audit. The deploy
// re-attach and the archiver's "file missing, re-download it" branch checked
// only rejectedImageUrls, so a fetch run re-downloaded the cleared 2007-era
// TodayTix art, and copied the deleted parent banners (an American in Paris
// 2015's Matthew Scott concert art, Company 2021's COMPANY XIV photo) onto two
// tours under their own folders with no recorded source.
const TT_EFFECT = 'https://images.ctfassets.net/6pezt69ih962/4oIOdVMdvX8tsExMGD19Vr/5c482b411daf0d92e6625bac8/poster.jpg?w=1080&h=1080&fit=fill&f=face&fm=webp&q=90';
const TT_AIP_HERO = 'https://images.ctfassets.net/6pezt69ih962/4ShMEuhPqLq0cQcsZHx0zJ/d288044bd8b79c9e8d34039cdbdf795d/TT-production-matthew.png?w=1920&h=800&fit=fill&f=center&fm=webp&q=90';
const TT_RACE_HERO = 'https://images.ctfassets.net/6pezt69ih962/3NU7KfZ6G2pdudGbtKS9AX/5934fb4beadef7ed6e9c632474b23ea2/West_TodayTix_1440x580.png?fm=webp&q=90';

test('mayServeDiskImage refuses a wrong-era TodayTix file even when the rejected list misses it', () => {
  // the-effect-west-end-2012 rejected only the todaytix.com page reference;
  // its thumbnail file is recorded from the Contentful asset.
  const effect = { id: 'the-effect-west-end-2012', market: 'west-end', status: 'closed', closingDate: '2013-02-23',
    images: { thumbnail: null, poster: null, hero: null },
    rejectedImageUrls: ['google-images:https://www.todaytix.com/london/shows/33425-the-effect'] };
  assert.equal(mayServeDiskImage(effect, TT_EFFECT), false);
  assert.match(refusedSourceReason(effect, TT_EFFECT), /closed before TodayTix/);
  // A current row's TodayTix art, and a non-TodayTix file, are still served.
  assert.equal(mayServeDiskImage({ id: 'x', status: 'open', images: {} }, TT_EFFECT), true);
  assert.equal(mayServeDiskImage(effect, 'https://www.theaterdiary.com/parse/files/x/effect.jpg'), true);
  assert.equal(mayServeDiskImage(effect, null), true);
});

test('missingFileRedownload refuses a borrowed parent file whose source is wrong for the parent', () => {
  // At run time the parent still listed the hero (its plan applied later),
  // with poster and thumbnail already cleared after a rejected TodayTix match.
  const parent = { id: 'an-american-in-paris-2015', status: 'closed', closingDate: '2016-10-09',
    images: { thumbnail: null, poster: null, hero: '/images/shows/an-american-in-paris-2015/hero.webp' },
    rejectedImageUrls: ['https://images.ctfassets.net/6pezt69ih962/1Vwgyv3zE6cmCrT18t1ENL/c5/TT-poster-matthew.png?fm=webp&q=90'] };
  // The tour had not yet recorded the rejection when the run read it.
  const tour = { id: 'an-american-in-paris-tour-2022', status: 'closed', closingDate: '2023-06-11',
    images: { hero: '/images/shows/an-american-in-paris-2015/hero.webp', thumbnail: null, poster: null } };
  const sources = { 'an-american-in-paris-2015': { hero: TT_AIP_HERO } };
  const byId = new Map([[parent.id, parent], [tour.id, tour]]);
  const r = missingFileRedownload(tour, 'hero', tour.images.hero, sources, byId);
  assert.ok(r.skip, 'must not re-download');
  assert.match(r.skip, /refused/);
  // Without the owner row it cannot judge the parent: it would download.
  assert.equal(missingFileRedownload(tour, 'hero', tour.images.hero, sources, new Map()).sourceUrl, TT_AIP_HERO);
  // Live case: the parent was refilled with its own poster after the cleanup,
  // so the wrong-era rule no longer fires, but the parent no longer serves the
  // hero the tour borrowed. Not re-downloaded either.
  const refilled = { ...parent, rejectedImageUrls: [], images: { thumbnail: '/images/shows/an-american-in-paris-2015/thumbnail.jpg', poster: '/images/shows/an-american-in-paris-2015/poster.jpg', hero: null } };
  assert.match(missingFileRedownload(tour, 'hero', tour.images.hero, sources, new Map([[refilled.id, refilled]])).skip, /no longer serves/);
  // A parent still serving the file (lost from disk only) is re-downloaded.
  const ok = 'https://www.theaterdiary.com/parse/files/x/aip.jpg';
  const serving = { ...refilled, images: { ...refilled.images, hero: tour.images.hero } };
  assert.deepEqual(missingFileRedownload(tour, 'hero', tour.images.hero, { [parent.id]: { hero: ok } }, new Map([[serving.id, serving]])), { sourceUrl: ok });
});

test('missingFileRedownload refuses a pre-TodayTix row and keeps the ordinary cases', () => {
  const race = { id: 'race-2009', status: 'closed', closingDate: '2010-08-21', images: { hero: '/images/shows/race-2009/hero.webp' } };
  assert.match(missingFileRedownload(race, 'hero', race.images.hero, { 'race-2009': { hero: TT_RACE_HERO } }, new Map()).skip, /closed before TodayTix/);
  // A good recorded source is re-downloaded; manual and missing sources are skipped.
  const ok = 'https://www.theaterdiary.com/parse/files/x/race.jpg';
  assert.deepEqual(missingFileRedownload(race, 'hero', race.images.hero, { 'race-2009': { hero: ok } }, new Map()), { sourceUrl: ok });
  assert.match(missingFileRedownload(race, 'hero', race.images.hero, { 'race-2009': { hero: 'manual:hand crop' } }, new Map()).skip, /not downloadable/);
  assert.match(missingFileRedownload(race, 'hero', race.images.hero, {}, new Map()).skip, /no source/);
  // A rejected source is refused as before (BRO-4901).
  const rej = { ...race, rejectedImageUrls: [ok] };
  assert.match(missingFileRedownload(rej, 'hero', race.images.hero, { 'race-2009': { hero: ok } }, new Map()).skip, /rejected/);
});

// BRO-7846: the 2026-11-19 finder run gave the-effect-west-end-2012 the 2023 NT
// revival's TodayTix art through a trusted tier that skips verifyAndCollect.
// applyImages must refuse a fresh candidate whose source refusedSourceReason flags.
test('the finder refuses refused sources for every tier in applyImages', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../fetch-show-images-auto.js', import.meta.url), 'utf8');
  const apply = src.slice(src.indexOf('function applyImages('));
  const body = apply.slice(0, apply.indexOf('\nfunction ', 10));
  assert.match(body, /refusedSourceReason\(show, src\)/);
  assert.match(body, /const src = freshSourceFor\(format, p, fileSources\)/);
  const effect = { id: 'the-effect-west-end-2012', market: 'west-end', status: 'closed', openingDate: '2012-11-13', closingDate: '2013-02-23', images: { thumbnail: null, poster: null, hero: null } };
  const nt2023 = 'https://images.ctfassets.net/6pezt69ih962/4oIOdVMdvX8tsExMGD19Vr/5c482b411daf0d92e6625bac8f1059f8/NTGDS_CC_The_Effect_Digital_TodayTix_20.jpg';
  assert.ok(refusedSourceReason(effect, nt2023));
});

test('freshSourceFor reads the served file source, or a CDN value', () => {
  const tt = 'google-images:https://www.todaytix.com/london/shows/1-x';
  const fs = { thumbnail: { path: '/images/shows/x/thumbnail.jpg', source: tt } };
  assert.equal(freshSourceFor('thumbnail', '/images/shows/x/thumbnail.jpg', fs), tt);
  assert.equal(freshSourceFor('thumbnail', '/images/shows/x/other.jpg', fs), null);
  assert.equal(freshSourceFor('poster', 'https://cdn.example/p.jpg', fs), 'https://cdn.example/p.jpg');
  assert.equal(freshSourceFor('poster', '/images/shows/x/poster.jpg', null), null);
  const effect = { id: 'e', market: 'west-end', status: 'closed', openingDate: '2012-11-13', closingDate: '2013-02-23', images: {} };
  assert.ok(refusedSourceReason(effect, freshSourceFor('thumbnail', '/images/shows/x/thumbnail.jpg', fs)));
});

// BRO-7871: --force sent local /images/ paths to fetch(), which cannot parse them,
// so the workflow's force_redownload re-downloaded nothing.
test('localImageAction: a local path is never fetched; --force re-downloads it from its source', () => {
  const local = '/images/shows/company-tour-2023/hero.webp';
  assert.equal(localImageAction(local, { force: true, fileExists: true }), 'redownload');
  assert.equal(localImageAction(local, { force: true, fileExists: false }), 'redownload');
  assert.equal(localImageAction(local, { force: false, fileExists: true }), 'check-existing');
  assert.equal(localImageAction(local, { force: false, fileExists: false }), 'redownload');
  assert.equal(localImageAction('https://cdn.example.com/a.jpg', { force: true, fileExists: false }), 'fetch');
  assert.equal(localImageAction(null, { force: true }), 'fetch');
});

test('archive-show-images routes local paths through localImageAction (class guard for BRO-7871)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../archive-show-images.js', import.meta.url), 'utf8');
  assert.match(src, /localImageAction\(url, \{ force/);
  assert.doesNotMatch(src, /url\.startsWith\('\/images\/'\) && !force/);
});
