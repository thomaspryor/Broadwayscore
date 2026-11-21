import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { STAR_SOURCE_BY_REFERENCE, starFallbackPatch } = require('../../scripts/lib/flagged-recovery.js');
const { KNOWN_STAR_OUTLETS } = require('../../scripts/lib/score-extractors.js');
const { extractBestOfTheatreRows } = require('../../scripts/lib/bestoftheatre-roundup-discover.js');
const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');

function stub(outletId, fields = {}) {
  return { showId: 'relay-test-west-end-2026', outletId, fullText: '', contentTier: 'stub',
    url: `https://example.com/reviews/${outletId}`, ...fields };
}
const relay = (data, source = 'bestoftheatre', stars = 4) =>
  starFallbackPatch(data, { stars, source }, KNOWN_STAR_OUTLETS);

for (const outlet of ['thestage', 'financialtimes', 'times-uk']) {
  test(`Best of Theatre relay persists stars and provenance on a ${outlet} paywall stub`, () => {
    const root = fs.mkdtempSync(path.resolve(import.meta.dirname, '../../.relay-bot-stars-'));
    try {
      const file = path.join(root, `${outlet}--unknown.json`);
      const data = stub(outlet);
      fs.writeFileSync(file, JSON.stringify(data));
      const patch = relay(data);
      assert.ok(patch);
      safeWriteReview(file, { ...data, ...patch });
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(written.aggregatorStars, '4/5');
      assert.equal(written.aggregatorStarsSource, 'bestoftheatre');
      assert.equal(written.scoreSource, 'bestoftheatre-star-rating');
      assert.equal(written.originalScore, undefined);
      assert.equal(written.fullText, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the Also reviewed by rating reaches the relay through the real parser', () => {
  const [row] = extractBestOfTheatreRows('<p><strong>Also reviewed by:</strong> <a href="https://www.thestage.co.uk/reviews/example">The Stage</a> (Dave Fargnoli, four stars)</p>');
  const patch = relay(stub('thestage', { url: row.url }), 'bestoftheatre', row.stars);
  assert.equal(patch.aggregatorStars, '4/5');
  assert.equal(patch.aggregatorStarsSource, 'bestoftheatre');
});

test('every existing WE reference relay records its own provenance', () => {
  for (const source of Object.keys(STAR_SOURCE_BY_REFERENCE)) {
    const patch = relay(stub('times-uk'), source, 3);
    assert.equal(patch.aggregatorStars, '3/5');
    assert.equal(patch.aggregatorStarsSource, source);
    assert.equal(patch.scoreSource, STAR_SOURCE_BY_REFERENCE[source]);
  }
});

test('existing outlet ratings, aggregator ratings and readable bodies are preserved', () => {
  for (const fields of [{ originalScore: '2/5' }, { aggregatorStars: '2/5', aggregatorStarsSource: 'theatre-reviews' }, { fullText: 'review '.repeat(100) }]) {
    assert.equal(relay(stub('thestage', fields)), null);
  }
});

test('unknown sources, missing stars and outlets without stars cannot acquire relay scores', () => {
  assert.equal(relay(stub('thestage'), 'untrusted'), null);
  for (const stars of [null, 0, -1, NaN]) {
    assert.equal(relay(stub('thestage'), 'bestoftheatre', stars), null);
  }
  assert.equal(relay(stub('not-a-star-outlet')), null);
});
