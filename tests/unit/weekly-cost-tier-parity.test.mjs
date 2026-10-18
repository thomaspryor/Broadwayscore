/**
 * BRO-5632: the site and the cost model agree on which weekly costs are
 * reported. The site prints a weekly cost as an "Estimate" unless it is a
 * reported figure with a publishable source (src/lib/commercial-display.ts
 * getWeeklyCostSourceLabel); the model counts it as a reported cost anchor
 * only then (scripts/lib/cost-history.js legacySourceType). Before BRO-5632
 * the model trusted the label alone, for 24 uncited costs. Runs in the tsx
 * batch; imports src TS directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { legacySourceType, REPORTED_SOURCE_TYPES } = require('../../scripts/lib/cost-history');
const { getWeeklyCostSourceLabel } = await import('../../src/lib/commercial-display.ts');

const siteReported = (r) => getWeeklyCostSourceLabel(r) !== 'Estimate';
const modelReported = (r) => REPORTED_SOURCE_TYPES.has(legacySourceType(r));

test('cited, uncited, vague and estimated costs read the same on the site and in the model', () => {
  const cases = [
    { weeklyRunningCost: 480577, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Forbes (Nov 17, 2025): fixed weekly operating costs of $480,577' },
    { weeklyRunningCost: 600000, costMethodology: 'trade-reported' },
    { weeklyRunningCost: 659000, costMethodology: 'sec-filing', weeklyRunningCostSource: 'Industry sources' },
    { weeklyRunningCost: 900000, costMethodology: 'producer-confirmed', isEstimate: { weeklyRunningCost: true }, weeklyRunningCostSource: "Gordon Cox interview with producer Chunsoo Shin (June 4, 2024): 'more than $900,000 per week'" },
    { weeklyRunningCost: 805000, costMethodology: 'reddit-standard', weeklyRunningCostSource: 'Estimate by u/Boring_Waltz_9545 on r/Broadway (2025-01-07)' },
    { weeklyRunningCost: 700000, costMethodology: 'industry-estimate' },
  ];
  for (const r of cases) assert.strictEqual(siteReported(r), modelReported(r), JSON.stringify(r));
});

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'commercial.json');
test('every weekly cost in commercial.json', { skip: !fs.existsSync(DATA) && 'private core data absent' }, () => {
  const shows = JSON.parse(fs.readFileSync(DATA, 'utf8')).shows;
  const mismatched = Object.entries(shows)
    .filter(([, r]) => r && r.weeklyRunningCost > 0 && siteReported(r) !== modelReported(r))
    .map(([slug, r]) => `${slug} (${r.costMethodology || 'no method'}: site ${siteReported(r) ? 'reported' : 'estimate'})`);
  assert.deepStrictEqual(mismatched, []);
});
