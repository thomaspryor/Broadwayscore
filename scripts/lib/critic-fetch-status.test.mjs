import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { criticFetchStatus, criticProgressLabel } = require('./critic-fetch-status.js');

test('every source failed is all-sources-failed, never a clean 0 missing', () => {
  assert.equal(criticFetchStatus(0, [{ source: 'muckrack', error: '403' }], 1), 'all-sources-failed');
  assert.equal(criticFetchStatus(0, [{ source: 'muckrack', error: '403' }, { source: 'nysr', error: 'x' }], 2), 'all-sources-failed');
});
test('some sources failed with no articles is fetch-failed; any article is ok', () => {
  assert.equal(criticFetchStatus(0, [{ source: 'muckrack', error: '403' }], 2), 'fetch-failed');
  assert.equal(criticFetchStatus(0, [], 1), 'no-articles-found');
  assert.equal(criticFetchStatus(3, [{ source: 'muckrack', error: '403' }], 2), 'ok');
});
test('progress label says FETCH FAILED instead of 0 missing', () => {
  assert.equal(criticProgressLabel({ error: 'all-sources-failed', errors: [{ source: 'muckrack' }] }), 'FETCH FAILED (muckrack)');
  assert.equal(criticProgressLabel({ error: 'fetch-failed', errors: [{ source: 'muckrack' }] }), 'FETCH FAILED (muckrack)');
  assert.equal(criticProgressLabel({ missingCount: 4 }), '4 missing');
  assert.equal(criticProgressLabel({}), '0 missing');
  assert.equal(criticProgressLabel({ error: 'no-articles-found' }), 'no-articles-found');
});
