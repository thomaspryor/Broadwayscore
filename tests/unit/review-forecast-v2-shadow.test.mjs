// BRO-7357: v2 shadow forecast. Requires the real module (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../../scripts/lib/review-forecast-v2-shadow.js');
const P = require('../../scripts/lib/review-forecast-pilot.js');
const MODEL = require('../../scripts/lib/review-forecast-v2-model.json');

const features = { mu: 74, x: Object.fromEntries(MODEL.model.names.map((n) => [n, 0])) };
const v1 = { forecast: 77, forecastRaw: 77.2, lo80: 63, hi80: 89 };
const BWAY = 'https://www.show-score.com/broadway-shows/downstate-broadway';
const SHARED = 'https://www.show-score.com/broadway-shows/mix-and-master';
const base = { features, v1, openingDate: '2026-11-19', recordedAt: '2026-11-10', pageUrl: BWAY };
const ss = { score: 90, count: 120, capturedAt: '2026-11-08' };

test('model is frozen and versioned', () => {
  assert.match(S.MODEL_VERSION, /^rf-v2-/);
  assert.equal(MODEL.shrinkK, 10);
  assert.equal(MODEL.shrinkCenter, 85);
});

test('uses Show Score when captured at or before opening minus 3 days; stores value, range, inputs, version', () => {
  const v2 = S.buildV2Shadow({ ...base, showScore: ss });
  assert.deepEqual(v2.inputsPresent, ['v1', 'showScore']);
  assert.equal(v2.modelVersion, S.MODEL_VERSION);
  assert.equal(v2.fallbackReason, null);
  assert.ok(v2.lo80 <= v2.forecast && v2.forecast <= v2.hi80);
  assert.ok(v2.forecast > v1.forecast - 1, 'a 90 Show Score should not lower a 74-mean forecast below v1-ish');
  assert.deepEqual(Object.keys(v2).sort(), [...S.V2_KEYS].sort());
});

test('falls back to v1 with a reason: no score, no capture date, late record, late capture', () => {
  const fb = (showScore, o = {}) => S.buildV2Shadow({ ...base, showScore, ...o });
  for (const [r, why] of [
    [fb(null), /no Show Score/],
    [fb({ score: 90, count: 0, capturedAt: '2026-11-08' }), /no Show Score/],
    [fb({ score: 90, count: 50, capturedAt: null }), /capture date missing/],
    [fb(ss, { recordedAt: '2026-11-17' }), /recorded after/],
    [fb({ ...ss, capturedAt: '2026-11-17' }), /capture after/],
  ]) {
    assert.deepEqual(r.inputsPresent, ['v1']);
    assert.equal(r.forecast, v1.forecast);
    assert.equal(r.lo80, v1.lo80);
    assert.match(r.fallbackReason, why);
  }
});

test('cutoff is inclusive: opening minus 3 days exactly is allowed', () => {
  const v2 = S.buildV2Shadow({ ...base, showScore: { ...ss, capturedAt: '2026-11-16' }, recordedAt: '2026-11-16' });
  assert.deepEqual(v2.inputsPresent, ['v1', 'showScore']);
});

test('count above the training range is clamped and flagged', () => {
  const big = S.buildV2Shadow({ ...base, showScore: { ...ss, count: 5000 } });
  const edge = S.buildV2Shadow({ ...base, showScore: { ...ss, count: S.TRAIN_COUNT_MAX } });
  assert.equal(big.showScore.countClamped, true);
  assert.equal(big.forecastRaw, edge.forecastRaw);
});

test('showScoreInput reads audience-buzz and takes the capture date from lastUpdated', () => {
  assert.deepEqual(S.showScoreInput({ sources: { showScore: { score: 92, reviewCount: 131, lastUpdated: '2026-11-08T05:00:00Z' } } }), { score: 92, count: 131, capturedAt: '2026-11-08' });
  assert.equal(S.showScoreInput({ sources: {} }), null);
  assert.equal(S.showScoreInput(null), null);
});

test('frozenV2Row: latest showScore-using row at or before cutoff; fallback rows ignored', () => {
  const mk = (d, used) => ({ showId: 'x', recordedAt: d, forecast: 70, v2: { inputsPresent: used ? ['v1', 'showScore'] : ['v1'], forecast: 72, showScoreMixedProductions: false } });
  const rows = [mk('2026-11-05', true), mk('2026-11-09', true), mk('2026-11-10', false), mk('2026-11-17', true)];
  assert.equal(S.frozenV2Row(rows, 'x', '2026-11-19').recordedAt, '2026-11-09');
  assert.equal(S.frozenV2Row(rows, 'y', '2026-11-19'), null);
  assert.equal(S.frozenV2Row([mk('2026-11-10', false)], 'x', '2026-11-19'), null);
  // legacy row (no flag) or a non-clean flag is never frozen as a clean v2 forecast
  const legacy = { ...mk('2026-11-09', true) }; delete legacy.v2.showScoreMixedProductions;
  assert.equal(S.frozenV2Row([legacy], 'x', '2026-11-19'), null);
  assert.equal(S.frozenV2Row([{ ...mk('2026-11-09', true), v2: { ...mk('2026-11-09', true).v2, showScoreMixedProductions: 'unknown' } }], 'x', '2026-11-19'), null);
});

test('grade row grades v2 beside v1 from the same ledger row', () => {
  const frozen = { showId: 'x', recordedAt: '2026-11-09', openingDate: '2026-11-19', forecast: 70, lo80: 56, hi80: 82, v2: { inputsPresent: ['v1', 'showScore'], forecast: 76, lo80: 62, hi80: 88, modelVersion: S.MODEL_VERSION } };
  const g = P.buildGradeRow({ showId: 'x', openingDate: '2026-11-19', today: '2026-12-25', frozen, criticScore: 80, frozenV2: frozen });
  assert.equal(g.v2UsedShowScore, true);
  assert.equal(g.forecastV2, 76);
  assert.equal(g.missForecastV2, 4);
  assert.equal(g.forecastV1SameRow, 70);
  assert.equal(g.missForecastV1SameRow, 10);
  assert.equal(g.inRange80V2, true);
  // no frozen v2: v2 equals v1
  const fb = P.buildGradeRow({ showId: 'x', openingDate: '2026-11-19', today: '2026-12-25', frozen: { ...frozen, v2: undefined }, criticScore: 80 });
  assert.equal(fb.v2UsedShowScore, false);
  assert.equal(fb.forecastV2, 70);
});

test('showScoreMixedProductions: -broadway page is false, shared or unmapped page is unknown, never true', () => {
  assert.equal(S.showScoreMixedProductions(BWAY), false);
  assert.equal(S.showScoreMixedProductions(BWAY + '/'), false);
  assert.equal(S.showScoreMixedProductions(SHARED), 'unknown');
  assert.equal(S.showScoreMixedProductions('https://www.show-score.com/broadway-shows/hangmen'), 'unknown');
  assert.equal(S.showScoreMixedProductions('https://www.show-score.com/off-broadway-shows/some-kilted-king-of-broadway'), 'unknown');
  assert.equal(S.showScoreMixedProductions(null), 'unknown');
  assert.equal(S.showScoreMixedProductions(undefined), 'unknown');
});

test('v2 stores the flag; a shared or unmapped page falls back to v1 with a stated reason', () => {
  const clean = S.buildV2Shadow({ ...base, showScore: ss });
  assert.equal(clean.showScoreMixedProductions, false);
  assert.deepEqual(clean.inputsPresent, ['v1', 'showScore']);
  for (const pageUrl of [SHARED, null]) {
    const v = S.buildV2Shadow({ ...base, showScore: ss, pageUrl });
    assert.equal(v.showScoreMixedProductions, 'unknown');
    assert.deepEqual(v.inputsPresent, ['v1']);
    assert.equal(v.forecast, v1.forecast);
    assert.match(v.fallbackReason, /not Broadway-specific/);
    assert.equal(v.showScore, null);
  }
  // a fallback for another reason still carries the flag
  assert.equal(S.buildV2Shadow({ ...base, showScore: null }).showScoreMixedProductions, false);
});

test('grade row carries the flag, and the scoreboard shows the clean page subset apart from the rest', () => {
  const mk = (id, flag, used, miss1, miss2) => ({ showId: id, v2UsedShowScore: used, v2ShowScoreMixed: flag, missForecast: miss1, missForecastV2: miss2, missForecastV1SameRow: miss1 });
  const sb = P.scoreboard([mk('a', false, true, 10, 4), mk('b', false, true, 6, 2), mk('c', 'unknown', false, 8, 8)]);
  assert.deepEqual(sb.v2Shadow.cleanPage, { v1SameRow: { n: 2, mae: 8 }, v2: { n: 2, mae: 3 } });
  assert.equal(sb.v2Shadow.mixedOrUnknownPage.shows, 1);
  const sb2 = P.scoreboard([mk('a', false, true, 10, 4), mk('d', false, false, 5, 5)]);
  assert.equal(sb2.v2Shadow.mixedOrUnknownPage.shows, 1, 'clean-page show whose v2 fell back is not in clean, so it is in the rest');
  assert.equal(sb.v2Shadow.mixedOrUnknownPage.v1.mae, 8);
  const frozen = { showId: 'x', recordedAt: '2026-11-09', openingDate: '2026-11-19', forecast: 70, lo80: 56, hi80: 82, v2: { inputsPresent: ['v1'], showScoreMixedProductions: 'unknown' } };
  const g = P.buildGradeRow({ showId: 'x', openingDate: '2026-11-19', today: '2026-12-25', frozen, criticScore: 80 });
  assert.equal(g.v2ShowScoreMixed, 'unknown');
});
