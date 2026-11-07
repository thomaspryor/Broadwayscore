import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reviewTextsDirFromEnv } = require('./review-texts-env-dir.js');

test('env var wins and is made absolute', () => {
  assert.equal(reviewTextsDirFromEnv('/default', { REVIEW_TEXTS_DIR: '/tmp/sandbox' }), '/tmp/sandbox');
});
test('relative value resolves against cwd', () => {
  assert.equal(reviewTextsDirFromEnv('/default', { REVIEW_TEXTS_DIR: 'rel/dir' }), process.cwd() + '/rel/dir');
});
test('unset or blank falls back to the default', () => {
  assert.equal(reviewTextsDirFromEnv('/default', {}), '/default');
  assert.equal(reviewTextsDirFromEnv('/default', { REVIEW_TEXTS_DIR: '  ' }), '/default');
});
test('gather-reviews.js resolves its corpus through the env-aware helper', () => {
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /const REVIEW_TEXTS_DIR = reviewTextsDirFromEnv\(/);
  assert.doesNotMatch(src, /const REVIEW_TEXTS_DIR = path\.join\(__dirname/);
});
