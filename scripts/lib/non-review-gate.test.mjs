import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockNonReviewGate } = require('./non-review-gate.js');

test('passes when there are zero definitive wrong-page hits among scored reviews', () => {
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 0 }), false);
});

test('blocks on ANY definitive wrong-page (weather/sports) — zero tolerance, 0 FP across 34k', () => {
  // The LA Times weather page scored 88 / Chicago Tribune sports page scored 72 class.
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 1 }), true);
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 5 }), true);
});

test('default floor is 0 (explicit floor still respected if ever raised)', () => {
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 2, floor: 2 }), false);
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 3, floor: 2 }), true);
});

// BRO-6114: "the weather forecast" in prose about a forecaster play is not a weather page.
test('weather_page pattern: prose about a forecaster passes, a real forecast grid still trips', () => {
  const pats = require('./non-review-patterns.js');
  const list = pats.NON_REVIEW_PATTERNS || pats.PATTERNS || Object.values(pats).find(Array.isArray);
  const hit = (t) => list.some(p => p.type === 'weather_page' && p.pattern.test(t));
  assert.equal(hit('A Scottish meteorologist who had to forecast D-Day: you find the weather forecast taking up the central position in drama.'), false);
  assert.equal(hit('THE WEATHER Forecast: sunny, high 72° low 55°'), true);
  assert.equal(hit('The weather for the county: rain'), true);
  assert.equal(hit('THE WEATHER\nForecast: Partly cloudy. Highs in the 70s, lows in the 50s.'), true);
});
