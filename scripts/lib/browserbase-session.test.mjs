import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeMetadataValue, createBbSession, _resetDayCapCacheForTests } = require('./browserbase-session.js');
const browserbaseLiveUsage = require('./browserbase-live-usage.js');
const openingNightSelection = require('./opening-night-selection.js');

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
  _resetDayCapCacheForTests();
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
  _resetDayCapCacheForTests();
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
  _resetDayCapCacheForTests();
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

test('createBbSession caches the live count briefly so back-to-back calls do not each hit the API (#1248 ship-check finding)', async () => {
  // Without this cache, centralizing the check here means collect-review-texts.js's
  // deliberate "re-check live count only every 5th session" cadence
  // (scripts/collect-review-texts.js ~line 2109) gets bypassed — every single
  // createBbSession() call would poll live, 5x'ing its API traffic on a big run.
  _resetDayCapCacheForTests();
  const prevMax = process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
  process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = '10';
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 3);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_789', connectUrl: 'wss://example.test' }),
  }));
  try {
    await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' });
    await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' });
    await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' });
    assert.equal(liveMock.mock.callCount(), 1, 'three rapid calls should share one cached live-count fetch');
  } finally {
    fetchMock.mock.restore();
    liveMock.mock.restore();
    _resetDayCapCacheForTests();
    if (prevMax === undefined) delete process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
    else process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = prevMax;
  }
});

test('createBbSession (#1333): a bulk caller is blocked below the raw ceiling once the opening-window reserve is applied', async () => {
  _resetDayCapCacheForTests();
  const prevMax = process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
  const prevArgv1 = process.argv[1];
  process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = '10';
  process.argv[1] = '/some/path/collect-review-texts.js'; // not on the exempt allowlist
  // 1 show in window * reservePerShow(5) = ceiling 10 -> effective 5. A live
  // count of 6 is UNDER the raw ceiling (would have been allowed pre-#1333)
  // but AT/OVER the reduced one (must be blocked now).
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 1);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 6);
  try {
    await assert.rejects(
      () => createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' }),
      /Browserbase daily cap reached \(6\/5 \(raw ceiling 10, reduced for opening-window reserve\)\)/,
    );
  } finally {
    windowMock.mock.restore();
    liveMock.mock.restore();
    process.argv[1] = prevArgv1;
    if (prevMax === undefined) delete process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
    else process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = prevMax;
  }
});

test('createBbSession (#1333): an exempt opening-night caller is NOT blocked by the same reduced ceiling', async () => {
  _resetDayCapCacheForTests();
  const prevMax = process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
  const prevArgv1 = process.argv[1];
  process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = '10';
  process.argv[1] = '/some/path/opening-night-poller.js'; // on the exempt allowlist
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 1);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 6);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_exempt', connectUrl: 'wss://example.test' }),
  }));
  try {
    // Same live count (6) that blocked the bulk caller above must succeed
    // here — the exempt caller checks the RAW ceiling (10), not the reduced one (5).
    const result = await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' });
    assert.equal(result.id, 'sess_exempt');
  } finally {
    fetchMock.mock.restore();
    windowMock.mock.restore();
    liveMock.mock.restore();
    process.argv[1] = prevArgv1;
    if (prevMax === undefined) delete process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
    else process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = prevMax;
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
