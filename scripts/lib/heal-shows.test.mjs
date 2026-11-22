// Tests for scripts/lib/heal-shows.js (BRO-8056 phase 1b). Requires the real module.
// Run: node --test scripts/lib/heal-shows.test.mjs
// Old-vs-new byte parity of pre-deploy-check.js on real shows.json (5 fixtures)
// was checked when this was extracted; these pin the behaviour per heal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { healShows } = require('./heal-shows.js');

const ctx = (files = [], extra = {}) => ({
  today: '2026-11-22',
  imagesPresent: true,
  imageExists: (p) => files.includes(p),
  imageSources: {},
  reviewCountByShow: {},
  ...extra,
});
const show = (o) => ({ id: 'x', title: 'X', status: 'open', category: 'broadway', venue: 'Some Theatre', images: {}, ...o });

test('clears a future closingDate on a closed show, keeps a human-locked one', () => {
  const data = { shows: [
    show({ id: 'a', status: 'closed', closingDate: '2099-01-01' }),
    show({ id: 'b', status: 'closed', closingDate: '2099-01-01', humanCorrectedClosingDate: true }),
    show({ id: 'c', status: 'closed', closingDate: '2026-01-01' }),
  ] };
  const r = healShows(data, ctx());
  assert.equal(data.shows[0].closingDate, null);
  assert.equal(data.shows[0].closingDateUpdatedAt, '2026-11-22', 'uses the injected today, not the clock');
  assert.equal(data.shows[1].closingDate, '2099-01-01');
  assert.equal(data.shows[2].closingDate, '2026-01-01');
  assert.equal(r.counts.statusDateHealed, 1);
  assert.equal(r.statusIssues, 1);
  assert.equal(r.changed, true);
});

test('flips London category by venue', () => {
  const data = { shows: [
    show({ id: 'a', category: 'off-west-end', venue: 'London Palladium' }),
    show({ id: 'b', category: 'west-end', venue: 'Donmar Warehouse' }),
    show({ id: 'c', category: 'broadway', venue: 'Donmar Warehouse' }),
  ] };
  const r = healShows(data, ctx());
  assert.deepEqual(data.shows.map(s => s.category), ['west-end', 'off-west-end', 'broadway']);
  assert.equal(r.counts.categoryFixed, 2);
});

test('image heals answer from imageExists, never the disk', () => {
  const files = ['/images/shows/a/poster.webp', '/images/shows/b/hero.webp'];
  const data = { shows: [
    show({ id: 'a', images: { hero: '/images/shows/a/hero.webp', poster: null, thumbnail: null } }),
    show({ id: 'b', images: { hero: '/images/shows/b/hero.jpg' } }),
  ] };
  const r = healShows(data, ctx(files));
  assert.equal(data.shows[0].images.hero, null, 'phantom path cleared');
  assert.equal(data.shows[0].images.poster, '/images/shows/a/poster.webp', 'null ref filled from a file that exists');
  // b: hero.jpg has no file, so it is phantom and cleared, then refilled with the webp.
  assert.equal(data.shows[1].images.hero, '/images/shows/b/hero.webp');
  assert.equal(r.counts.danglingRefsFixed, 2);
});

test('no image tree means nothing reads as missing', () => {
  const data = { shows: [show({ id: 'a', images: { hero: '/images/shows/a/hero.webp' } })] };
  const r = healShows(data, ctx([], { imagesPresent: false }));
  assert.equal(data.shows[0].images.hero, '/images/shows/a/hero.webp');
  assert.equal(r.changed, false);
});

test('a clean input is untouched and reports no change', () => {
  const data = { shows: [show({ id: 'a', images: { hero: '/images/shows/a/hero.webp' } })] };
  const before = JSON.stringify(data);
  const r = healShows(data, ctx(['/images/shows/a/hero.webp']));
  assert.equal(JSON.stringify(data), before);
  assert.equal(r.changed, false);
});

test('rejects a missing clock or image oracle', () => {
  assert.throws(() => healShows({ shows: [] }, ctx([], { today: undefined })), /today/);
  assert.throws(() => healShows({ shows: [] }, ctx([], { imageExists: undefined })), /imageExists/);
});
