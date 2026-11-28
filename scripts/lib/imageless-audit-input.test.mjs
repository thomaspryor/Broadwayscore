import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { normalizeImageAuditInputs, findRegionalImageGaps } = require('./imageless-audit-input');
const { buildNoReliableArtMarker } = require('./no-reliable-art');
const { findImagelessScoredShows } = require('./image-trigger-guard');
const nowMs = Date.parse('2026-11-12T12:00:00Z');
const regional = (id, city, extra = {}) => ({ id, title: id, city, category: 'regional', ...extra });
const normalize = (shows, options = {}) => normalizeImageAuditInputs(
  { shows }, { reviews: shows.map(s => ({ showId: s.id })) }, { nowMs, ...options },
);

test('regional acceptance catches closed, fresh and undated scored gaps in all three markets', () => {
  const shows = [
    regional('uk', 'glasgow-uk', { status: 'closed', openingDate: '2026-10-07' }),
    regional('chicago', 'chicago-il', { discoveredAt: '2026-11-12T11:00:00Z' }),
    regional('dc', 'washington-dc'),
    regional('uk-without-city', undefined, { venue: 'Hope Mill Theatre, Manchester' }),
    regional('other-regional', 'los-angeles-ca'),
    { id: 'west-end', category: 'west-end', city: 'london-uk' },
  ];
  assert.deepEqual(findRegionalImageGaps(normalize(shows)).map(s => s.id),
    ['uk', 'chicago', 'dc', 'uk-without-city']);
});

test('normalization counts reviews in each supported data shape and excludes unreviewed rows', () => {
  const shows = { shows: [regional('reviewed', 'chicago-il'), regional('unreviewed', 'washington-dc')] };
  const records = [{ showId: 'reviewed' }, { showId: 'reviewed' }];
  for (const reviews of [records, { reviews: records }, { reviews: { a: records[0], b: records[1] } }]) {
    const normalized = normalizeImageAuditInputs(shows, reviews, { nowMs });
    assert.equal(normalized[0].reviewCount, 2);
    assert.deepEqual(findRegionalImageGaps(normalized).map(s => s.id), ['reviewed']);
  }
});

test('coverage requires actual files, not phantom paths or directory names', t => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regional-art-test-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(publicDir, 'real.webp'), Buffer.from('RIFF test image'));
  fs.mkdirSync(path.join(publicDir, 'directory.webp'));
  const shows = [
    regional('real', 'chicago-il', { images: { hero: '/real.webp' } }),
    regional('phantom', 'washington-dc', { images: { poster: '/missing.webp' } }),
    regional('directory', 'glasgow-uk', { images: { thumbnail: '/directory.webp' } }),
  ];
  assert.deepEqual(findRegionalImageGaps(normalize(shows, { imageOptions: { publicDir } })).map(s => s.id),
    ['phantom', 'directory']);
});

test('only current noReliableArt markers excuse a missing image', () => {
  const marked = regional('marked', 'chicago-il', { venue: 'Theater Wit', openingDate: '2026-01-01' });
  marked.noReliableArt = buildNoReliableArtMarker(marked, { now: nowMs, reason: 'All candidates rejected' });
  const changed = { ...marked, id: 'changed', venue: 'Other venue' };
  const expired = { ...marked, id: 'expired', status: 'open', todaytixId: 123,
    noReliableArt: { ...marked.noReliableArt, at: '2026-10-01' } };
  const malformed = { ...marked, id: 'malformed', noReliableArt: true };
  assert.deepEqual(findRegionalImageGaps(normalize([marked, changed, expired, malformed])).map(s => s.id),
    ['changed', 'expired', 'malformed']);
});

test('shared audit input preserves oldest date, the dispatch grace period, and tour parent routing', () => {
  const normalized = normalize([
    regional('old', 'chicago-il', { openingDate: '2020-01-01', discoveredAt: '2026-11-12' }),
    regional('fresh', 'washington-dc', { discoveredAt: '2026-11-12T11:00:00Z' }),
    { id: 'tour', category: 'tour', tourOf: 'parent', previewsStartDate: '2026-01-01' },
  ]);
  assert.equal(normalized[0].sinceMs, Date.parse('2020-01-01'));
  assert.equal(normalized[2].dispatchId, 'parent');
  assert.deepEqual(findImagelessScoredShows(normalized, { nowMs }).map(s => s.id), ['old', 'tour']);
});

test('missing or malformed core data cannot produce a green coverage check', () => {
  const shows = { shows: [regional('one', 'chicago-il')] };
  for (const bad of [null, {}, { shows: [] }]) {
    assert.throws(() => normalizeImageAuditInputs(bad, [{ showId: 'one' }]), /shows.json/);
  }
  for (const bad of [null, {}, [], { reviews: {} }, { reviews: 'bad' }, { reviews: [null] }, [{ score: 80 }]]) {
    assert.throws(() => normalizeImageAuditInputs(shows, bad), /reviews/);
  }
});

// BRO-7560: noises-off-west-end-2019 had poster.jpg + thumbnail.jpg on disk while
// shows.json images were all null. Those files came from sources the show rejects
// (sfplayhouse.org, an Amazon Broadway poster: rejectedImageUrls), and bandstand-2017 /
// rocky-2014 hold the same shape for fact-checked wrong-production art. A file in the
// show's directory is therefore NOT coverage: only a usable path in shows.json is.
// Falling back to the directory (hasArchivedShowImages) would silently count wrong art.
test('rejected art left on disk with null shows.json images is not coverage (noises-off shape)', t => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageless-leftover-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  const dir = path.join(publicDir, 'images', 'shows', 'noises-off-west-end-2019');
  fs.mkdirSync(path.join(dir, 'sm'), { recursive: true });
  for (const f of ['poster.jpg', 'thumbnail.jpg', 'sm/poster.jpg.webp', 'sm/thumbnail.jpg.webp']) {
    fs.writeFileSync(path.join(dir, f), Buffer.alloc(11321, 1));
  }
  const noisesOff = {
    id: 'noises-off-west-end-2019', title: 'Noises Off', category: 'west-end', status: 'closed',
    venue: 'Garrick Theatre', openingDate: '2019-10-03', previewsStartDate: '2019-09-27',
    images: { thumbnail: null, poster: null, hero: null },
    rejectedImageUrls: [
      'google-images:https://sfplayhouse.org/2025-2026-season/noises-off/',
      'google-images:https://www.amazon.com/Noises-Off-Broadway-Poster-Style/dp/B003SIDESG',
    ],
  };
  const recorded = { ...noisesOff, id: 'old-times-west-end-2013',
    images: { thumbnail: '/images/shows/old-times-west-end-2013/thumbnail.jpg', poster: null, hero: null } };
  const recordedDir = path.join(publicDir, 'images', 'shows', recorded.id);
  fs.mkdirSync(recordedDir, { recursive: true });
  fs.writeFileSync(path.join(recordedDir, 'thumbnail.jpg'), Buffer.alloc(16070, 1));

  const normalized = normalize([noisesOff, recorded], { imageOptions: { publicDir } });
  assert.equal(normalized[0].hasImages, false, 'leftover files must not count when shows.json images are null');
  assert.equal(normalized[1].hasImages, true, 'a recorded path with a real file is coverage');
  assert.deepEqual(findImagelessScoredShows(normalized, { nowMs }).map(s => s.id), ['noises-off-west-end-2019']);

  // A noReliableArt marker is what settles such a row (BRO-6703), not the files.
  const marked = { ...noisesOff, noReliableArt: buildNoReliableArtMarker(noisesOff, { now: nowMs, reason: 'self-heal searches found no matching art' }) };
  const [m] = normalize([marked], { imageOptions: { publicDir } });
  assert.equal(m.hasImages, false);
  assert.equal(m.noReliableArt, true);
});
