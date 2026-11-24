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
const { hasArchivedShowImages } = require('./show-images');
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

test('rejected Noises Off orphan files cannot masquerade as usable art', t => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageless-orphan-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  const id = 'noises-off-west-end-2019';
  const dir = path.join(publicDir, 'images', 'shows', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'poster.jpg'), 'rejected art');
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), 'rejected art');
  const show = { id, title: 'Noises Off', venue: 'Garrick Theatre', openingDate: '2019-10-03', images: { poster: null, thumbnail: null, hero: null } };
  show.noReliableArt = buildNoReliableArtMarker(show, { now: nowMs, reason: 'All candidates rejected' });
  const [result] = normalize([show], { imageOptions: { publicDir } });
  assert.equal(hasArchivedShowImages(path.join(publicDir, 'images', 'shows'), id), true);
  assert.equal(result.hasImages, false);
  assert.equal(result.noReliableArt, true);
  const recorded = require('../../data/image-sources.json')[id];
  const rejected = {
    poster: 'google-images:https://www.amazon.com/Noises-Off-Broadway-Poster-Style/dp/B003SIDESG',
    thumbnail: 'google-images:https://sfplayhouse.org/2025-2026-season/noises-off/',
  };
  for (const role of ['poster', 'thumbnail']) {
    if (recorded?.[role] !== rejected[role]) continue; // New, verified art may replace it.
    const archive = path.join(process.cwd(), 'public', 'images', 'shows', id);
    assert.equal(fs.existsSync(path.join(archive, `${role}.jpg`)), false, `rejected ${role} remains`);
    assert.equal(fs.existsSync(path.join(archive, 'sm', `${role}.jpg.webp`)), false, `rejected ${role} variant remains`);
  }
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
