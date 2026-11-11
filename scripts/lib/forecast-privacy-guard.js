/**
 * forecast-privacy-guard.js (BRO-7357): the public repo must never hold review forecasts (v1 or the v2 shadow).
 * Forecast rows live only in the private core-data repo (review-forecast-pilot/ledger, grades). This module finds
 * ledger-row signatures in git-tracked PUBLIC files. Pure scanning, no writes.
 *
 * Signature = a forecast value key (FORECAST_VALUE_KEYS) appearing together with a row-shape key (ROW_SHAPE_KEYS),
 * or a v2 model-version string. The v2 key list comes from the real shadow module, so a new v2 field is covered
 * automatically and a v2 field dropped from this list makes tests/unit/forecast-privacy-guard.test.mjs go red.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { V2_KEYS } = require('./review-forecast-v2-shadow.js');

const V1_VALUE_KEYS = ['forecastRaw', 'categoryMean', 'missForecast', 'frozenRecordedAt'];
const V2_VALUE_KEYS = ['forecastV2', 'missForecastV2', 'forecastV1SameRow', 'inRange80V2', 'v2ModelVersion', ...V2_KEYS.filter((k) => k !== 'forecast' && k !== 'showScore')];
const FORECAST_VALUE_KEYS = [...new Set([...V1_VALUE_KEYS, ...V2_VALUE_KEYS])];
// Keys that only exist on v2 rows: flagged on their own, no row-shape key needed (catches id-keyed maps, nested objects).
const DISTINCT_KEYS = ['forecastV2', 'missForecastV2', 'forecastV1SameRow', 'inRange80V2', 'v2ModelVersion', 'inputsPresent'];
const ROW_SHAPE_KEYS = ['showId', 'recordedAt', 'openingDate'];
const MODEL_VERSION_PREFIX = /rf-v2-[a-z0-9-]+/;
// Code, tests, docs, the frozen model JSON and agent memory may name these fields; data files may not.
const ALLOWED = [/^scripts\//, /^tests\//, /^docs\//, /^\.claude\//, /^\.github\//, /^memory\//, /^cloud-memory\//, ];

function hasKey(text, key) { return new RegExp('"' + key + '"\\s*:').test(text); }

/** Which signature (or null) a file's text carries. `valueKeys` is injectable so tests can prove coverage. */
function scanContent(text, valueKeys = FORECAST_VALUE_KEYS, distinctKeys = DISTINCT_KEYS) {
  if (MODEL_VERSION_PREFIX.test(text) && /"modelVersion"|"v2ModelVersion"/.test(text)) return 'v2-model-version';
  const d = distinctKeys.find((k) => hasKey(text, k));
  if (d) return 'v2-key:' + d;
  if (!ROW_SHAPE_KEYS.some((k) => hasKey(text, k))) return null;
  const hit = valueKeys.find((k) => hasKey(text, k));
  return hit ? 'forecast-key:' + hit : null;
}

function trackedPublicFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 }).toString('utf8');
  return out.split('\0').filter((f) => f && /\.(json|jsonl|csv|txt|md|js|mjs|cjs|ts|tsx|yml|yaml|html)$/.test(f) && !ALLOWED.some((re) => re.test(f)));
}

/** Scan every tracked public data file. Returns [{file, signature}]. */
function scanTracked(root, valueKeys = FORECAST_VALUE_KEYS) {
  const leaks = [];
  for (const f of trackedPublicFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const sig = scanContent(text, valueKeys);
    if (sig) leaks.push({ file: f, signature: sig });
  }
  return leaks;
}

module.exports = { DISTINCT_KEYS, FORECAST_VALUE_KEYS, V2_VALUE_KEYS, ROW_SHAPE_KEYS, scanContent, scanTracked, trackedPublicFiles };
