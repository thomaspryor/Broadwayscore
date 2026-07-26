/**
 * scripts/lib/diary-lookup-entry.js — the build-time CommonJS mirror of the
 * pure helpers in src/lib/stats/.
 *
 * The generator is a CommonJS prebuild script with no TS loader, so the mirror
 * has to exist. This test is what stops it drifting: it diffs the mirror
 * against the real TypeScript over every venue in shows.json,
 * diary-shows.json, west-end-venues.json and theater-metadata.json. Change the
 * TS normalizer without porting it and this fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeForMatch, normalizeVenueKey } from '../../src/lib/stats/venue-match';
import { parseRuntimeMinutes } from '../../src/lib/stats/parse';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const mirror = require(join(ROOT, 'scripts/lib/diary-lookup-entry.js'));

const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const SHOWS = (() => {
  const raw = readJson('data/shows.json');
  return Array.isArray(raw) ? raw : raw.shows;
})();
const DIARY_SHOWS = readJson('data/diary-shows.json').shows || [];
const WEST_END = readJson('data/west-end-venues.json');
const HOUSES = Object.keys(readJson('data/theater-metadata.json')).filter((k) => !k.startsWith('_'));

const VENUE_CORPUS = (() => {
  const set = new Set();
  for (const s of SHOWS) if (s.venue) set.add(s.venue);
  for (const s of DIARY_SHOWS) if (s.venue) set.add(s.venue);
  for (const v of WEST_END) set.add(v);
  for (const h of HOUSES) set.add(h);
  return [...set];
})();

test('the venue corpus is big enough for the parity check to mean something', () => {
  assert.ok(VENUE_CORPUS.length > 1000, `corpus is only ${VENUE_CORPUS.length} venues`);
});

test('PARITY: normalizeVenueKey matches the TypeScript across every real venue', () => {
  const diffs = VENUE_CORPUS.filter((v) => mirror.normalizeVenueKey(v) !== normalizeVenueKey(v));
  assert.deepEqual(diffs.slice(0, 10), [], `${diffs.length} venues disagree`);
});

test('PARITY: normalizeForMatch matches the TypeScript across every real venue', () => {
  const diffs = VENUE_CORPUS.filter((v) => mirror.normalizeForMatch(v) !== normalizeForMatch(v));
  assert.deepEqual(diffs.slice(0, 10), [], `${diffs.length} venues disagree`);
});

test('PARITY: normalizers agree on null, empty and odd inputs', () => {
  for (const v of [null, undefined, '', '   ', 'TBA', 'Audible’s Minetta Lane Theatre']) {
    assert.equal(mirror.normalizeVenueKey(v), normalizeVenueKey(v), JSON.stringify(v));
    assert.equal(mirror.normalizeForMatch(v), normalizeForMatch(v), JSON.stringify(v));
  }
});

test('PARITY: parseRuntimeMinutes matches the TypeScript across every real runtime', () => {
  const runtimes = new Set();
  for (const s of SHOWS) if (s.runtime != null) runtimes.add(s.runtime);
  for (const extra of [null, undefined, '', 'TBA', 0, -5, 150, '2h', '95m', '1 hr 45 min']) {
    runtimes.add(extra);
  }
  assert.ok(runtimes.size > 20, `only ${runtimes.size} distinct runtimes`);
  const diffs = [...runtimes].filter(
    (r) => mirror.parseRuntimeMinutes(r) !== parseRuntimeMinutes(r)
  );
  assert.deepEqual(diffs.slice(0, 10), [], `${diffs.length} runtimes disagree`);
});

test('statsFieldsFor emits rt and vk, and omits them when unknown', () => {
  assert.deepEqual(statsOf({ runtime: '2h 30m', venue: 'Booth Theatre' }), { rt: 150, vk: 'booth' });
  assert.deepEqual(statsOf({ runtimeMinutes: 95, venue: 'St. James Theatre' }), {
    rt: 95,
    vk: 'st james',
  });
  // No runtime → no rt key at all (the consumer applies the type fallback).
  assert.deepEqual(statsOf({ venue: 'Booth Theatre' }), { vk: 'booth' });
  // No venue → no vk key.
  assert.deepEqual(statsOf({ runtime: '2h' }), { rt: 120 });
  // Nothing usable → an empty object, never nulls in the artifact.
  assert.deepEqual(statsOf({}), {});
  assert.deepEqual(statsOf({ runtime: 'TBA', venue: '' }), {});
});

function statsOf(show) {
  return mirror.statsFieldsFor(show);
}

test('ADDITIVE ONLY: the generator keeps every pre-existing diary-lookup field', () => {
  // Reproduces the generator's entry construction and asserts the original
  // key set survives. /diary-show and MyShowsClient read these by key.
  const show = {
    id: 'x-2026',
    title: 'X',
    slug: 'x-2026',
    venue: 'Booth Theatre',
    category: 'broadway',
    openingDate: '2026-01-01',
    city: 'New York',
    country: 'US',
    posterUrl: 'https://example.test/p.jpg',
    runtime: '2h 30m',
  };
  const entry = { id: show.id, t: show.title, s: show.slug, v: show.venue || '', dy: 1 };
  if (show.category) entry.c = show.category;
  if (show.openingDate) entry.od = show.openingDate;
  if (show.city) entry.ci = show.city;
  if (show.country) entry.co = show.country;
  if (show.posterUrl) entry.p = show.posterUrl;
  Object.assign(entry, mirror.statsFieldsFor(show));

  for (const k of ['id', 't', 's', 'v', 'dy', 'c', 'od', 'ci', 'co', 'p']) {
    assert.ok(k in entry, `field ${k} was dropped`);
  }
  assert.equal(entry.v, 'Booth Theatre', 'the raw venue string is still there');
  assert.equal(entry.rt, 150);
  assert.equal(entry.vk, 'booth');
});

test('the generator actually wires the helper in', () => {
  const src = readFileSync(join(ROOT, 'scripts/generate-diary-data.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/diary-lookup-entry['"]\)/);
  assert.match(src, /Object\.assign\(entry, statsFieldsFor\(show\)\)/);
});
