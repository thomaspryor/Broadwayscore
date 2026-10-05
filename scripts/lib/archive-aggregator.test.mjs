import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildBrightDataRequest, fetchWithBrightData } = require('./archive-aggregator.js');

test('uses REST endpoint with Bearer token, never the raw superproxy', () => {
  const r = buildBrightDataRequest('https://x.test/a', ' tok ', '');
  assert.equal(r.url, 'https://api.brightdata.com/request');
  assert.equal(r.config.headers.Authorization, 'Bearer tok');
  assert.deepEqual(r.body, { zone: 'web_unlocker2', url: 'https://x.test/a', format: 'raw' });
  assert.equal(r.config.proxy, undefined);
});

test('zone override honoured', () => {
  assert.equal(buildBrightDataRequest('u', 't', ' serp_api1 ').body.zone, 'serp_api1');
});

test('fetch returns body; empty body and missing token throw', async () => {
  const ok = await fetchWithBrightData('u', 't', null, async () => ({ data: '<html>hi</html>' }));
  assert.equal(ok, '<html>hi</html>');
  await assert.rejects(fetchWithBrightData('u', 't', null, async () => ({ data: '  ' })), /empty/);
  assert.throws(() => buildBrightDataRequest('u', '', null), /missing/);
});

test('workflow no longer uses the superproxy raw-protocol auth (BRO-3486 regression)', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/archive-aggregator-pages.yml', import.meta.url), 'utf8');
  assert.ok(!wf.includes('superproxy.io'));
  assert.ok(wf.includes("require('./scripts/lib/archive-aggregator.js')"));
});
