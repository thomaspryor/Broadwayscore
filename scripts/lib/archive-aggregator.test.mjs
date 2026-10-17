import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchWithBrightData } = require('./archive-aggregator.js');

test('returns content from scraper tier; null/empty/error-header throw', async () => {
  const ok = await fetchWithBrightData('u', async (u, o) => ({ content: '<html>hi</html>', brdError: null, o }));
  assert.equal(ok, '<html>hi</html>');
  await assert.rejects(fetchWithBrightData('u', async () => null), /no content/);
  await assert.rejects(fetchWithBrightData('u', async () => ({ content: '  ' })), /empty/);
  await assert.rejects(fetchWithBrightData('u', async () => ({ content: '<p>x</p>', brdError: 'blocked' })), /blocked/);
});

test('default path is scraper.js fetchWithBrightData (caps + telemetry choke point)', () => {
  const src = fs.readFileSync(new URL('./archive-aggregator.js', import.meta.url), 'utf8');
  assert.ok(src.includes("require('./scraper').fetchWithBrightData"));
  assert.equal(typeof require('./scraper').fetchWithBrightData, 'function');
});

test('workflow no longer uses the superproxy raw-protocol auth (BRO-3486 regression)', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/archive-aggregator-pages.yml', import.meta.url), 'utf8');
  assert.ok(!wf.includes('superproxy.io'));
  assert.ok(wf.includes("require('./scripts/lib/archive-aggregator.js')"));
});
