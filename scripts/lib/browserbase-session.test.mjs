import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeMetadataValue } = require('./browserbase-session.js');

test('sanitizeMetadataValue passes through already-safe values unchanged', () => {
  assert.equal(sanitizeMetadataValue('gather-reviews.js'), 'gather-reviews.js');
  assert.equal(sanitizeMetadataValue('scrape-thestage-roundups.js'), 'scrape-thestage-roundups.js');
});

test('sanitizeMetadataValue replaces spaces (the live 2026-08-02 400 case)', () => {
  // Real Browserbase 400: "Value is not a valid metadata value: manual paywalled-access diagnostic"
  assert.equal(sanitizeMetadataValue('manual paywalled-access diagnostic'), 'manual-paywalled-access-diagnostic');
  assert.equal(sanitizeMetadataValue('Stagedoor critic-reviews Cloudflare bypass'), 'Stagedoor-critic-reviews-Cloudflare-bypass');
});

test('sanitizeMetadataValue replaces colons and slashes', () => {
  assert.equal(sanitizeMetadataValue('has:colon/slash'), 'has-colon-slash');
});

test('sanitizeMetadataValue collapses runs and trims leading/trailing dashes', () => {
  assert.equal(sanitizeMetadataValue('  leading and trailing  '), 'leading-and-trailing');
});

test('sanitizeMetadataValue passes null/undefined through unchanged', () => {
  assert.equal(sanitizeMetadataValue(null), null);
  assert.equal(sanitizeMetadataValue(undefined), undefined);
});

test('sanitizeMetadataValue never returns empty string for all-disallowed input', () => {
  assert.equal(sanitizeMetadataValue(':::'), null);
});

test('sanitizeMetadataValue caps length at 255', () => {
  const long = 'a'.repeat(400);
  assert.equal(sanitizeMetadataValue(long).length, 255);
});
