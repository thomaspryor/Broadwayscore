// BRO-2862: drift guard for the three venue-token vocabularies.
//   venueSearchToken  (venue-search-token.js)  durable Playbill cache query term
//   venueQueryToken   (serp-review-census.js)  review-census SERP query term
//   hasDisambiguator  (url-discovery.js)       venue filter on SERP candidates
// They deliberately differ in stopword breadth (see venue-search-token.js header),
// so this does not demand equal output. It pins the invariants they must share,
// over every real venue in data/shows.json plus a fixed fixture list, so a change
// to one list that breaks the contract fails here instead of drifting silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { venueSearchToken, GENERIC } = require('./venue-search-token.js');
const { venueQueryToken } = require('./serp-review-census.js');
const { hasDisambiguator } = require('./url-discovery.js');

const FIXTURE = [
  'Studio 54', 'WP Theater', 'New World Stages', 'Playhouse Theatre', 'The Theater Center',
  'Theatre Royal Haymarket', 'Noël Coward Theatre', 'St. James Theatre', 'New Amsterdam Theatre',
  '59E59 Theaters', 'Park Avenue Armory', 'Theatre Row - Theatre Three', "Wyndham's Theatre",
  'Lyceum Theatre', 'Stage 42', '', null, undefined,
];
let real = [];
try {
  const raw = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8'));
  real = (Array.isArray(raw) ? raw : raw.shows || []).map((s) => s.venue);
} catch (e) { if (e.code !== 'ENOENT') throw e; /* cloud copies may be absent; fixtures still run */ }
const VENUES = [...new Set([...FIXTURE, ...real].filter((v) => v !== undefined))];

const GENERIC_WORDS = new Set(['theatre', 'theater', 'theatres', 'theaters']);

test('neither query helper ever returns a bare generic theatre noun', () => {
  for (const v of VENUES) {
    const a = venueSearchToken(v).toLowerCase();
    const b = venueQueryToken(v);
    assert.ok(!GENERIC_WORDS.has(a), `venueSearchToken(${v}) = ${a}`);
    assert.ok(!GENERIC_WORDS.has(b), `venueQueryToken(${v}) = ${b}`);
  }
});

test('census token is accepted by hasDisambiguator for the same venue (documented mirror)', () => {
  for (const v of VENUES) {
    const b = venueQueryToken(v);
    if (b) assert.ok(hasDisambiguator(b, { venue: v }), `${v} -> ${b}`);
  }
});

test('search token is never empty where census finds a distinctive token', () => {
  for (const v of VENUES) {
    const b = venueQueryToken(v);
    // '' is intended when search treats the census token as generic ("The Space")
    if (b && !GENERIC.has(b)) assert.notEqual(venueSearchToken(v), '', `${v}`);
  }
});

test('empty venue yields no token from any helper', () => {
  for (const v of ['', null, undefined]) {
    assert.equal(venueSearchToken(v), '');
    assert.equal(venueQueryToken(v), null);
    assert.equal(hasDisambiguator('anything', { venue: v }), false);
  }
});
