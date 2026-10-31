import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildRetryCandidateImages } = require('./google-image-retry-candidate.js');

test('carries forward a previously-fetched poster when the thumbnail candidate is retried', () => {
  const images = buildRetryCandidateImages({
    showId: 'gimme-a-sign-off-broadway-2026',
    previousPoster: '/images/shows/gimme-a-sign-off-broadway-2026/poster.jpg',
  });
  assert.equal(images.poster, '/images/shows/gimme-a-sign-off-broadway-2026/poster.jpg');
  assert.equal(images.thumbnail, '/images/shows/gimme-a-sign-off-broadway-2026/thumbnail.jpg');
  assert.equal(images.hero, null);
});

test('poster stays null when no poster was found in the first pass (no regression)', () => {
  const images = buildRetryCandidateImages({ showId: 'some-show-2026' });
  assert.equal(images.poster, null);
});

test('an explicit null previousPoster does not throw and stays null', () => {
  const images = buildRetryCandidateImages({ showId: 'some-show-2026', previousPoster: null });
  assert.equal(images.poster, null);
});
