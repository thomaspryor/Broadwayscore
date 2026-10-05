// BRO-4668: decide whether test.yml's E2E job waits for this push to deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { touchesSiteCode, isLiveStatus, isNullSha } = require('./e2e-await-deploy.js');

test('site code changes trigger a wait', () => {
  assert.equal(touchesSiteCode(['src/components/auth/SignInModal.tsx', 'tests/e2e/user-flows.spec.ts']), true);
  assert.equal(touchesSiteCode(['next.config.js']), true);
  assert.equal(touchesSiteCode(['tailwind.config.ts']), true);
});

test('bot data churn, scripts and tests alone do not', () => {
  assert.equal(touchesSiteCode(['public/data/shows/hamilton-2015.json', 'data/audit/scraper-spend-ledger.jsonl']), false);
  assert.equal(touchesSiteCode(['scripts/gather-reviews.js', 'tests/unit/tour-links.test.ts']), false);
  assert.equal(touchesSiteCode(['srcfoo/x.ts', 'next.config.js.bak']), false);
  assert.equal(touchesSiteCode([]), false);
});

test('compare status → live', () => {
  assert.equal(isLiveStatus('ahead'), true);
  assert.equal(isLiveStatus('identical'), true);
  assert.equal(isLiveStatus('behind'), false);
  assert.equal(isLiveStatus('diverged'), false);
  assert.equal(isLiveStatus('unknown'), false);
});

test('null push base', () => {
  assert.equal(isNullSha('0000000000000000000000000000000000000000'), true);
  assert.equal(isNullSha(''), true);
  assert.equal(isNullSha(undefined), true);
  assert.equal(isNullSha('193732a0352'), false);
});
