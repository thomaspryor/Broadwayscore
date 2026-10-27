import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'fs';
const { isLabOnlyNoise, actionableSeoAnomalies } = createRequire(import.meta.url)('./seo-lab-noise.js');

test('BRO-477: lab-only drops and lab-only low scores are not actionable; real-visitor and error rows are', () => {
  const drop = { type: 'cwv_lighthouse_drop', severity: 'warning', message: '/off-broadway: simulated-test score dropped to 73 (was 90)' };
  const labLow = { type: 'cwv_lighthouse_low', severity: 'warning', message: '/west-end: scored 67/100 on a simulated phone test (below 70) \u2014 simulated test only; real visitors are fine, usually ignorable' };
  const realLow = { type: 'cwv_lighthouse_low', severity: 'error', message: '/x: scored 60/100 AND real visitors\' LCP is 4000ms over the target \u2014 this one is real' };
  const lcp = { type: 'cwv_lcp_regression', severity: 'warning', message: '/x: real visitors\' LCP got worse' };
  assert.strictEqual(isLabOnlyNoise(drop), true);
  assert.strictEqual(isLabOnlyNoise(labLow), true);
  assert.strictEqual(isLabOnlyNoise(realLow), false);
  assert.deepStrictEqual(actionableSeoAnomalies([drop, labLow, realLow, lcp]), [realLow, lcp]);
  assert.deepStrictEqual(actionableSeoAnomalies(undefined), []);
});

test('BRO-477: health-check SEO row uses the shared filter', () => {
  const src = fs.readFileSync(new URL('../health-check.js', import.meta.url), 'utf8');
  assert.ok(src.includes("require('./lib/seo-lab-noise').actionableSeoAnomalies(data.anomalies)"));
});
