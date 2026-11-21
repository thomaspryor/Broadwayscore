/**
 * Unit tests for hasTryoutUrlMarker and TRYOUT_URL_MARKERS
 * (scripts/lib/content-filters.js — Schmigadoon 2026 Bug #8).
 *
 * The filter is applied at SERP discovery time by url-discovery.js
 * and at BWW-roundup slug validation time by bww-roundup-validator.js.
 * A miss here = a wrong-production URL shipping into reviews.json.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { hasTryoutUrlMarker, TRYOUT_URL_MARKERS } = require('../../scripts/lib/content-filters.js');
const { validateBWWRoundupUrlMatchesShow } = require('../../scripts/lib/bww-roundup-validator.js');

describe('TRYOUT_URL_MARKERS catalogue integrity', () => {
  test('includes the core Schmigadoon 2026 incident markers', () => {
    const required = [
      'world-premiere',
      'kennedy-center',
      'pre-broadway',
      'tryout',
      'out-of-town',
    ];
    for (const m of required) {
      assert.ok(TRYOUT_URL_MARKERS.includes(m), `missing required marker: ${m}`);
    }
  });

  test('includes the TV/film/streaming markers (Apple TV+ Schmigadoon class)', () => {
    const required = ['tv-review', 'film-review', 'apple-tv', 'streaming-review'];
    for (const m of required) {
      assert.ok(TRYOUT_URL_MARKERS.includes(m), `missing required marker: ${m}`);
    }
  });

  test('all markers are lowercase (hasTryoutUrlMarker lower-cases input)', () => {
    for (const m of TRYOUT_URL_MARKERS) {
      assert.strictEqual(m, m.toLowerCase(), `marker not lowercase: ${m}`);
    }
  });

  test('no generic words like "review" or "theater" (would cause FPs)', () => {
    const banned = ['review', 'theater', 'theatre', 'show', 'musical'];
    for (const m of TRYOUT_URL_MARKERS) {
      for (const b of banned) {
        assert.notStrictEqual(m, b, `generic marker "${b}" would cause FPs`);
      }
    }
  });
});

describe('hasTryoutUrlMarker behavior', () => {
  test('Kennedy Center world-premiere URL → rejected (Schmigadoon 2026 incident)', () => {
    const r = hasTryoutUrlMarker('https://www.broadwayworld.com/article/Review-Roundup-SCHMIGADOON-Kennedy-Center-World-Premiere-20250616');
    assert.strictEqual(r.rejected, true);
    assert.ok(['world-premiere', 'kennedy-center'].includes(r.marker));
  });

  test('Apple TV+ review URL → rejected', () => {
    const r = hasTryoutUrlMarker('https://variety.com/2021/tv/reviews/schmigadoon-tv-review-apple-tv-1234902395/');
    assert.strictEqual(r.rejected, true);
  });

  test('La Jolla Playhouse tryout URL → rejected', () => {
    const r = hasTryoutUrlMarker('https://latimes.com/entertainment/theater/story/la-jolla-playhouse-world-premiere-12345');
    assert.strictEqual(r.rejected, true);
  });

  test('legitimate Broadway NYT review URL → accepted', () => {
    const r = hasTryoutUrlMarker('https://www.nytimes.com/2026/04/20/theater/schmigadoon-review.html');
    assert.strictEqual(r.rejected, false);
  });

  test('legitimate BWW Broadway roundup URL → accepted', () => {
    const r = hasTryoutUrlMarker('https://www.broadwayworld.com/article/Review-Roundup-SCHMIGADOON-Opens-on-Broadway-20260420');
    assert.strictEqual(r.rejected, false);
  });

  test('null/undefined/empty input → not rejected (safe default)', () => {
    assert.strictEqual(hasTryoutUrlMarker(null).rejected, false);
    assert.strictEqual(hasTryoutUrlMarker(undefined).rejected, false);
    assert.strictEqual(hasTryoutUrlMarker('').rejected, false);
    assert.strictEqual(hasTryoutUrlMarker(42).rejected, false);
  });

  test('case-insensitive match (uppercase URL segment)', () => {
    const r = hasTryoutUrlMarker('https://www.broadwayworld.com/article/SOMETHING-WORLD-PREMIERE-Review');
    assert.strictEqual(r.rejected, true);
  });

  test('underscore variant (world_premiere) also rejected', () => {
    const r = hasTryoutUrlMarker('https://example.com/something_world_premiere_review');
    assert.strictEqual(r.rejected, true);
  });
});

describe('bww-roundup-validator still rejects tryout slugs after refactor', () => {
  test('Schmigadoon Kennedy Center roundup URL rejected for Schmigadoon', () => {
    const ok = validateBWWRoundupUrlMatchesShow(
      'https://www.broadwayworld.com/article/Review-Roundup-SCHMIGADOON-Kennedy-Center-World-Premiere-20250616',
      'Schmigadoon'
    );
    assert.strictEqual(ok, false);
  });

  test('La Jolla tryout roundup rejected even with matching title words', () => {
    const ok = validateBWWRoundupUrlMatchesShow(
      'https://www.broadwayworld.com/article/Review-Roundup-SOMESHOW-La-Jolla-Tryout-20250101',
      'Someshow'
    );
    assert.strictEqual(ok, false);
  });

  test('clean Broadway roundup URL still accepted', () => {
    const ok = validateBWWRoundupUrlMatchesShow(
      'https://www.broadwayworld.com/article/Review-Roundup-HAMILTON-Opens-on-Broadway-20150806',
      'Hamilton'
    );
    assert.strictEqual(ok, true);
  });
});
