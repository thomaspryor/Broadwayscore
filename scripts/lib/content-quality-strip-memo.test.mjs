// BRO-8013: the stripVenueListingsTrailer memo must return exactly what the
// uncached strip returns, never serve a stale answer across an outlet or a
// trailer kill switch, and actually be hit by classifyContentTier (which strips
// the same trimmed fullText twice per call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cq = require('./content-quality.js');
const { stripVenueListingsTrailer, stripVenueListingsTrailerUncached, stripMemoStats, classifyContentTier } = cq;

const BODY = 'The production is a joy from start to finish, and the cast sings with real conviction throughout the evening. '.repeat(4);
const CASES = [
  BODY.trim(),
  `${BODY}Listings and ticket information can be found here.`,
  `${BODY}Hayes Theater 240 West 44th Street New York, NY 10036`,
  `${BODY}Photos by Joan Marcus`,
  `${BODY}It runs until 7 June.`,
];

test('memo returns the uncached result for every case, first and repeat call', () => {
  for (const t of CASES) {
    const want = stripVenueListingsTrailerUncached(t, 'stagebuddy');
    assert.equal(stripVenueListingsTrailer(t, 'stagebuddy'), want);
    assert.equal(stripVenueListingsTrailer(t, 'stagebuddy'), want);
  }
});

test('an outlet mismatch is recomputed, not served from the memo', () => {
  const t = CASES[3];
  stripVenueListingsTrailer(t, 'thestage');
  const misses = stripMemoStats.misses;
  assert.equal(stripVenueListingsTrailer(t, 'telegraph'), stripVenueListingsTrailerUncached(t, 'telegraph'));
  assert.equal(stripMemoStats.misses, misses + 1);
});

test('toggling a trailer kill switch is never served a stale strip', () => {
  const t = CASES[4];
  const prev = process.env.TRAILER_FIXES_DISABLED;
  try {
    delete process.env.TRAILER_FIXES_DISABLED;
    const on = stripVenueListingsTrailer(t, null);
    process.env.TRAILER_FIXES_DISABLED = 'true';
    const off = stripVenueListingsTrailer(t, null);
    assert.equal(off, stripVenueListingsTrailerUncached(t, null));
    assert.notEqual(on, off, 'fixture must be stripped only with the trailer fixes on');
  } finally {
    if (prev === undefined) delete process.env.TRAILER_FIXES_DISABLED; else process.env.TRAILER_FIXES_DISABLED = prev;
  }
});

test('classifyContentTier reuses the strip within one call (fails if the memo is removed)', () => {
  const hits = stripMemoStats.hits;
  classifyContentTier({ fullText: `${BODY} A unique closing line ${Date.now()}.`, outletId: 'stagebuddy' });
  assert.ok(stripMemoStats.hits > hits, 'second strip of the same text should be a memo hit');
});
