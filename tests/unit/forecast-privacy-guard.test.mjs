// BRO-7357: forecasts (v1 and v2 shadow) must never land in the public repo. Requires the real guard + real v2 builder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../../scripts/lib/forecast-privacy-guard.js');
const S = require('../../scripts/lib/review-forecast-v2-shadow.js');

const features = { mu: 74 };
const v1 = { forecast: 77, forecastRaw: 77.2, lo80: 63, hi80: 89 };
const realV2 = S.buildV2Shadow({ features, v1, showScore: { score: 90, count: 120, capturedAt: '2026-11-01' }, openingDate: '2026-11-19', recordedAt: '2026-11-10' });
const row = (extra) => JSON.stringify({ showId: 'x', recordedAt: '2026-11-10', openingDate: '2026-11-19', ...extra });

test('every key the real v2 builder emits is covered by the guard (v2 field coverage)', () => {
  for (const k of Object.keys(realV2)) {
    if (k === 'forecast' || k === 'showScore') continue; // generic names, covered via the row-level v2 keys below
    assert.ok(G.V2_VALUE_KEYS.includes(k), `guard does not cover v2 key ${k}`);
  }
});

test('RED: a planted v2 value in a public data file is flagged, for each v2 key', () => {
  for (const k of G.V2_VALUE_KEYS) assert.ok(G.scanContent(row({ [k]: 1 })), `v2 key ${k} not flagged`);
  assert.ok(G.scanContent(row({ v2: realV2 })), 'a whole ledger row with v2 is not flagged');
  assert.equal(G.scanContent('{"modelVersion":"rf-v2-showscore-meann-2026-11-11"}'), 'v2-model-version');
});

test('RED: removing v2 field coverage from the guard lets a planted v2 row through (the guard test catches it)', () => {
  const weakened = G.FORECAST_VALUE_KEYS.filter((k) => !G.V2_VALUE_KEYS.includes(k));
  assert.equal(G.scanContent(row({ forecastV2: 80, inRange80V2: true }), weakened), null); // would leak
  assert.ok(G.scanContent(row({ forecastV2: 80, inRange80V2: true })), 'full guard must flag it');
});

test('GREEN: ordinary public data rows are not flagged', () => {
  assert.equal(G.scanContent(row({ criticScore: 78 })), null);
  assert.equal(G.scanContent('{"forecast": 3}'), null);
});

test('GREEN: no git-tracked public data file carries a forecast row signature', () => {
  const leaks = G.scanTracked(process.cwd());
  assert.deepEqual(leaks, []);
});
