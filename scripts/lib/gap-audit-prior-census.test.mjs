import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { priorCensusUrls } = require('./gap-audit-merge.js');

test('BRO-5516: prior census candidate URLs are carried when the census is skipped', () => {
  const row = { censusVerdict: { candidates: [
    { url: 'https://a.com/r1' }, { url: 'https://a.com/r1' }, { url: 'https://b.com/r2' }, { url: '' }, { url: 'not-a-url' }, null,
  ] } };
  assert.deepEqual(priorCensusUrls(row), ['https://a.com/r1', 'https://b.com/r2']);
});

test('BRO-5516: absent / malformed prior rows yield nothing', () => {
  assert.deepEqual(priorCensusUrls(undefined), []);
  assert.deepEqual(priorCensusUrls({}), []);
  assert.deepEqual(priorCensusUrls({ censusVerdict: { candidates: 'x' } }), []);
});

test('BRO-5516: real audit rows carry their census (sting-west-end-2026 had 3 live)', async () => {
  const fs = require('node:fs');
  if (!fs.existsSync('data/audit/show-review-gap.json')) return;
  const a = JSON.parse(fs.readFileSync('data/audit/show-review-gap.json', 'utf8'));
  const withCensus = a.results.filter(r => priorCensusUrls(r).length > 0);
  assert.ok(withCensus.length > 100);
});
