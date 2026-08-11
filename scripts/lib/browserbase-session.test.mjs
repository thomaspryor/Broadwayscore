import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeMetadataValue, createBbSession } = require('./browserbase-session.js');

test('createBbSession rejects when BROWSERBASE_KILL_SWITCH=true, before any network call', async () => {
  const prev = process.env.BROWSERBASE_KILL_SWITCH;
  process.env.BROWSERBASE_KILL_SWITCH = 'true';
  try {
    // No apiKey/projectId supplied — if the kill switch didn't short-circuit
    // first, this would throw the "not set" error instead, not the kill-switch one.
    await assert.rejects(
      () => createBbSession({ caller: 'test-caller' }),
      /Browserbase kill switch active/,
    );
  } finally {
    if (prev === undefined) delete process.env.BROWSERBASE_KILL_SWITCH;
    else process.env.BROWSERBASE_KILL_SWITCH = prev;
  }
});

test('createBbSession does not trip the kill-switch check when unset', async () => {
  const prevKs = process.env.BROWSERBASE_KILL_SWITCH;
  const prevKey = process.env.BROWSERBASE_API_KEY;
  const prevProject = process.env.BROWSERBASE_PROJECT_ID;
  delete process.env.BROWSERBASE_KILL_SWITCH;
  delete process.env.BROWSERBASE_API_KEY;
  delete process.env.BROWSERBASE_PROJECT_ID;
  try {
    // No apiKey/projectId anywhere — should fail on the credentials check, not the kill switch.
    await assert.rejects(
      () => createBbSession({ caller: 'test-caller' }),
      /BROWSERBASE_API_KEY \/ BROWSERBASE_PROJECT_ID not set/,
    );
  } finally {
    if (prevKs === undefined) delete process.env.BROWSERBASE_KILL_SWITCH; else process.env.BROWSERBASE_KILL_SWITCH = prevKs;
    if (prevKey === undefined) delete process.env.BROWSERBASE_API_KEY; else process.env.BROWSERBASE_API_KEY = prevKey;
    if (prevProject === undefined) delete process.env.BROWSERBASE_PROJECT_ID; else process.env.BROWSERBASE_PROJECT_ID = prevProject;
  }
});

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
