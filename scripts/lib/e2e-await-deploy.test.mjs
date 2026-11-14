// BRO-4668: decide whether test.yml's E2E job waits for undeployed site code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { touchesSiteCode, decide, E2E_SITE_PATHS } = require('./e2e-await-deploy.js');
const { SITE_PATHS } = require('./should-deploy-gate.js');

test('site code changes trigger a wait', () => {
  assert.equal(touchesSiteCode(['src/components/auth/SignInModal.tsx', 'tests/e2e/user-flows.spec.ts']), true);
  assert.equal(touchesSiteCode(['next.config.js']), true);
  assert.equal(touchesSiteCode(['vercel.json']), true);
  assert.equal(touchesSiteCode(['package-lock.json']), true);
  assert.equal(touchesSiteCode(['public/images/logo.svg']), true);
  assert.equal(touchesSiteCode(['content/guides/tony-awards.md']), true);
});

test('bot data churn, scripts and tests alone do not', () => {
  assert.equal(touchesSiteCode(['public/data/shows/hamilton-2015.json', 'data/audit/scraper-spend-ledger.jsonl']), false);
  assert.equal(touchesSiteCode(['scripts/gather-reviews.js', 'tests/unit/tour-links.test.ts']), false);
  assert.equal(touchesSiteCode(['srcfoo/x.ts', 'next.config.js.bak']), false);
  assert.equal(touchesSiteCode([]), false);
});

test('follows the deploy gate list, minus scripts/', () => {
  assert.deepEqual(E2E_SITE_PATHS, SITE_PATHS.filter((p) => p !== 'scripts/'));
});

test('decide: target already deployed', () => {
  assert.equal(decide({ status: 'identical', files: [] }), 'live');
  assert.equal(decide({ status: 'behind', files: [{ filename: 'src/x.tsx' }] }), 'live');
});

test('decide: judges the whole undeployed diff, not one push', () => {
  // A data-only push on top of an undeployed feature still waits.
  const cmp = { status: 'ahead', files: [{ filename: 'public/data/shows/a.json' }, { filename: 'src/components/A.tsx' }] };
  assert.equal(decide(cmp), 'wait');
  assert.equal(decide({ status: 'ahead', files: [{ filename: 'public/data/shows/a.json' }] }), 'no-site-code');
});

test('decide: rename out of src/ counts as a site change', () => {
  assert.equal(decide({ status: 'ahead', files: [{ filename: 'archive/Old.tsx', previous_filename: 'src/components/Old.tsx' }] }), 'wait');
});

test('decide: a full 300-file page may hide site code, so wait', () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `public/data/shows/s${i}.json` }));
  assert.equal(decide({ status: 'ahead', files }), 'wait');
});
