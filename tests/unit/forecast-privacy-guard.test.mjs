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
  assert.equal(G.scanContent(row({ forecastV2: 80, inRange80V2: true }), weakened, []), null); // would leak
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

test('RED: v2-only keys are flagged even without a row-shape key (id-keyed map, nested object)', () => {
  assert.ok(G.scanContent('{"downstate-2026":{"v2":{"forecast":80,"inputsPresent":["v1","showScore"]}}}'));
});

// ---- BRO-7382: v3 earlier-run blend shadow ----
const V3 = require('../../scripts/lib/review-forecast-v3-blend.js');
const v2obj = S.buildV2Shadow({ features, v1, showScore: { score: 90, count: 120, capturedAt: '2026-11-01' }, openingDate: '2026-11-19', recordedAt: '2026-11-10', pageUrl: 'https://x/broadway-shows/foo-broadway' });
const earlier = { n: 12, raw: 80, score: 78, source: 'own-record', origin: 'London', ref: 'foo-2024', newest: '2026-08-01' };
const realV3 = V3.buildV3Shadow({ v2: v2obj, earlier, weightRows: [], openingDate: '2026-11-19', recordedAt: '2026-11-10' });

test('v3: every key the real v3 builder emits is covered by the guard and is v3-prefixed', () => {
  for (const k of Object.keys(realV3)) {
    assert.ok(G.V3_VALUE_KEYS.includes(k), `guard does not cover v3 key ${k}`);
    assert.ok(G.DISTINCT_KEYS.includes(k), `v3 key ${k} is not flagged on its own`);
    assert.match(k, /^v3[A-Z]/, `v3 key ${k} must carry the v3 prefix (generic names would collide with public data)`);
  }
});

test('v3 RED: a planted v3 value is flagged for each v3 key, a whole ledger row with v3 too, and the model version', () => {
  for (const k of G.V3_VALUE_KEYS) assert.ok(G.scanContent(row({ [k]: 1 })), `v3 key ${k} not flagged`);
  assert.ok(G.scanContent(row({ v3: realV3 })), 'a whole ledger row with v3 is not flagged');
  assert.ok(G.scanContent(JSON.stringify({ [Object.keys(realV3)[0]]: 1 })), 'v3 key alone (no row shape) is not flagged');
  assert.equal(G.scanContent('{"v3ModelVersion":"' + V3.MODEL_VERSION + '"}'), 'v2-model-version');
  assert.ok(G.scanContent('{"grades":{"downstate":{"forecastV3":80,"missForecastV3":2.1}}}'));
});

test('v3 RED: a guard without v3 coverage lets a planted v3 row through (so the coverage assertions above matter)', () => {
  const weakened = G.FORECAST_VALUE_KEYS.filter((k) => !G.V3_VALUE_KEYS.includes(k));
  const weakDistinct = G.DISTINCT_KEYS.filter((k) => !G.V3_VALUE_KEYS.includes(k));
  const { v3ModelVersion, ...noVersion } = realV3; // the model-version regex is a separate net; isolate the key coverage
  assert.equal(G.scanContent(row({ v3: noVersion }), weakened, weakDistinct), null);
  assert.ok(G.scanContent(row({ v3: noVersion })), 'the real guard must flag the same row');
});

test('v3 GREEN: the committed historical weight rows are not flagged', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../../data/audit/review-forecast-v3-weight-rows.json', import.meta.url), 'utf8');
  assert.equal(G.scanContent(text), null);
});
