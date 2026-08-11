import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeMetadataValue, createBbSession } = require('./browserbase-session.js');
const browserbaseLiveUsage = require('./browserbase-live-usage.js');

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

test('createBbSession rejects when the live daily session count is at/over the cap (#1248)', async () => {
  const prevMax = process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
  process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = '10';
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 10);
  try {
    await assert.rejects(
      () => createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' }),
      /Browserbase daily cap reached \(10\/10\)/,
    );
    assert.equal(liveMock.mock.callCount(), 1);
  } finally {
    liveMock.mock.restore();
    if (prevMax === undefined) delete process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
    else process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = prevMax;
  }
});

test('createBbSession proceeds past the day-cap check when the live count is under the cap', async () => {
  const prevMax = process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
  process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = '10';
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 9);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_123', connectUrl: 'wss://example.test' }),
  }));
  try {
    const result = await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' });
    assert.equal(result.id, 'sess_123');
    assert.equal(liveMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
    liveMock.mock.restore();
    if (prevMax === undefined) delete process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
    else process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = prevMax;
  }
});

test('createBbSession does not block on a null live count (network hiccup treated as unknown, not zero)', async () => {
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => null);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_456', connectUrl: 'wss://example.test' }),
  }));
  try {
    const result = await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' });
    assert.equal(result.id, 'sess_456');
  } finally {
    fetchMock.mock.restore();
    liveMock.mock.restore();
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
