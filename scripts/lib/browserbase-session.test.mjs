import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Redirect the durable spend ledger BEFORE loading the module under test:
// every createBbSession() below records a row via provider-telemetry.js, and
// without this the 'test-caller' rows landed in the REAL
// data/audit/scraper-spend-ledger.jsonl (528 rows/week measured 2026-09-07),
// making the daily digest report ~92% Browserbase attribution to a caller
// that never opened a session. Same escape hatch provider-telemetry.js
// documents for its own tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-session-test-')), 'ledger.jsonl');
// The day-cap tests below use a 10-session ceiling; the BRO-5243 recovery
// reserve (default 30) would swallow it. The reserve has its own tests at the end.
process.env.BROWSERBASE_RECOVERY_RESERVE = '0';

const require = createRequire(import.meta.url);
const { sanitizeMetadataValue, createBbSession, BB_CATEGORIES, _resetDayCapCacheForTests, _setNowForTests } = require('./browserbase-session.js');
// Pin the clock after the BRO-5243 Tier-1 boost expired, so every test sees the
// unboosted limits unless it opts into a boosted date.
const AFTER_BOOST = '2026-11-01T12:00:00Z';
_setNowForTests(AFTER_BOOST);
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
  // No shows in the opening window — isolates this test from #1333's reserve
  // logic (and from real data/shows.json content, which changes daily and
  // would otherwise make this test's pass/fail depend on live production data).
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 0);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 10);
  try {
    await assert.rejects(
      () => createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' }),
      (err) => /Browserbase daily cap reached \(10\/10\)/.test(err.message) && err.bbNoSession === true,
    );
    assert.equal(liveMock.mock.callCount(), 1);
  } finally {
    windowMock.mock.restore();
    liveMock.mock.restore();
    if (prevMax === undefined) delete process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
    else process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = prevMax;
  }
});

test('createBbSession proceeds past the day-cap check when the live count is under the cap', async () => {
  _resetDayCapCacheForTests();
  const prevMax = process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
  process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = '10';
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 0);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 9);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_123', connectUrl: 'wss://example.test' }),
  }));
  try {
    const result = await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' });
    assert.equal(result.id, 'sess_123');
    assert.equal(liveMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
    windowMock.mock.restore();
    liveMock.mock.restore();
    if (prevMax === undefined) delete process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY;
    else process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = prevMax;
  }
});

test('createBbSession does not block on a null live count (network hiccup treated as unknown, not zero)', async () => {
  _resetDayCapCacheForTests();
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 0);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => null);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_456', connectUrl: 'wss://example.test' }),
  }));
  try {
    const result = await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' });
    assert.equal(result.id, 'sess_456');
  } finally {
    fetchMock.mock.restore();
    windowMock.mock.restore();
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
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 0);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 3);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_789', connectUrl: 'wss://example.test' }),
  }));
  try {
    await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' });
    await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' });
    await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' });
    assert.equal(liveMock.mock.callCount(), 1, 'three rapid calls should share one cached live-count fetch');
  } finally {
    fetchMock.mock.restore();
    windowMock.mock.restore();
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
      () => createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' }),
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
    const result = await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'discovery' });
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

test('createBbSession (BRO-3097) records host and category on the ledger row', async () => {
  _resetDayCapCacheForTests();
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 0);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 0);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_bro3097', connectUrl: 'wss://example.test' }),
  }));
  try {
    await createBbSession({
      apiKey: 'k', projectId: 'p',
      caller: 'test-caller',
      host: 'nytimes.com',
      category: 'review-text',
    });
    const lines = fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.host, 'nytimes.com');
    assert.equal(row.category, 'review-text');
  } finally {
    fetchMock.mock.restore();
    windowMock.mock.restore();
    liveMock.mock.restore();
  }
});

test('createBbSession (BRO-3097) rejects an unrecognized category before any network call', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should never be called — category validation must short-circuit first');
  });
  try {
    await assert.rejects(
      () => createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'typo-category' }),
      /opts\.category is required and must be one of review-text\/discovery/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('createBbSession (BRO-3097) rejects a missing category the same way as a missing caller', async () => {
  await assert.rejects(
    () => createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller' }),
    /opts\.category is required and must be one of review-text\/discovery/,
  );
});

test('createBbSession (BRO-3097) sends host/category through to Browserbase userMetadata, sanitized', async () => {
  _resetDayCapCacheForTests();
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 0);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 0);
  let capturedBody = null;
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ id: 'sess_meta', connectUrl: 'wss://example.test' }) };
  });
  try {
    await createBbSession({
      apiKey: 'k', projectId: 'p',
      caller: 'test-caller',
      host: 'nytimes.com',
      category: 'review-text',
    });
    assert.equal(capturedBody.userMetadata.host, 'nytimes.com');
    assert.equal(capturedBody.userMetadata.category, 'review-text');
  } finally {
    fetchMock.mock.restore();
    windowMock.mock.restore();
    liveMock.mock.restore();
  }
});

test('BB_CATEGORIES exposes exactly the two valid category values', () => {
  assert.deepEqual(BB_CATEGORIES, ['review-text', 'discovery']);
});

test('createBbSession (BRO-3097) leaves host null when a caller passes category but omits host (host stays optional)', async () => {
  _resetDayCapCacheForTests();
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => 0);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => 0);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'sess_bro3097_bare', connectUrl: 'wss://example.test' }),
  }));
  try {
    await createBbSession({ apiKey: 'k', projectId: 'p', caller: 'test-caller', category: 'review-text' });
    const lines = fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.host, null);
    assert.equal(row.category, 'review-text');
  } finally {
    fetchMock.mock.restore();
    windowMock.mock.restore();
    liveMock.mock.restore();
  }
});

// ---------- BRO-5243: allocation (deny list, recovery reserve, capped opening-window reserve) ----------

// Ambient settings that would shift the expected limits if set in the shell.
const AMBIENT_ENV = ['BROWSERBASE_DENY_HOSTS', 'BROWSERBASE_OPENING_WINDOW_RESERVE_MAX', 'BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW', 'BROWSERBASE_EXEMPT_SCRIPTS', 'BD_OPENING_NIGHT', 'GITHUB_WORKFLOW', 'BROWSERBASE_TIER1_BOOST_DISABLED'];
// now defaults to after the Tier-1 boost expired, so these tests pin the unboosted limits.
async function withBb({ max = '250', reserve = '30', useReserve, windowShows = 0, live, host, expectFetch = true, now = AFTER_BOOST, exemptWorkflow, caller = 'test-caller', callerUsed = 0 }, fn) {
  _resetDayCapCacheForTests();
  _setNowForTests(now);
  const prev = {
    max: process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY,
    reserve: process.env.BROWSERBASE_RECOVERY_RESERVE,
    use: process.env.BROWSERBASE_USE_RESERVE,
    ambient: Object.fromEntries(AMBIENT_ENV.map(k => [k, process.env[k]])),
  };
  for (const k of AMBIENT_ENV) delete process.env[k];
  process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY = max;
  process.env.BROWSERBASE_RECOVERY_RESERVE = reserve;
  if (useReserve) process.env.BROWSERBASE_USE_RESERVE = 'true'; else delete process.env.BROWSERBASE_USE_RESERVE;
  if (exemptWorkflow) process.env.BD_OPENING_NIGHT = 'true';
  const windowMock = mock.method(openingNightSelection, 'countShowsInOpeningWindow', () => windowShows);
  const liveMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseSessionsToday', async () => live);
  const callerMock = mock.method(browserbaseLiveUsage, 'fetchLiveBrowserbaseCallerSessionsToday', async () => callerUsed);
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200, json: async () => ({ id: 'sess_ok', connectUrl: 'wss://example.test' }),
  }));
  try {
    await fn(() => createBbSession({ apiKey: 'k', projectId: 'p', caller, category: 'review-text', host }), { liveMock, fetchMock, callerMock });
  } finally {
    fetchMock.mock.restore(); windowMock.mock.restore(); liveMock.mock.restore(); callerMock.mock.restore();
    _setNowForTests(AFTER_BOOST);
    for (const [k, v] of [['BROWSERBASE_MAX_SESSIONS_PER_DAY', prev.max], ['BROWSERBASE_RECOVERY_RESERVE', prev.reserve], ['BROWSERBASE_USE_RESERVE', prev.use], ...AMBIENT_ENV.map(k => [k, prev.ambient[k]])]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('BRO-5243: a denied host is refused before the live count and before any fetch', async () => {
  await withBb({ live: 0, host: 'uk.trustpilot.com' }, async (call, { liveMock, fetchMock }) => {
    await assert.rejects(call, /Browserbase host denied \(uk\.trustpilot\.com\)/);
    assert.equal(liveMock.mock.callCount(), 0);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

test('BRO-5243: the host-denied message is not a cap deferral', () => {
  const { routeCapFromBrowserbaseError } = require('./failed-fetch-policy.js');
  assert.equal(routeCapFromBrowserbaseError('Browserbase host denied (facebook.com): not a review host'), null);
  assert.equal(routeCapFromBrowserbaseError('Browserbase recovery reserve held (150/145)'), 'reserve');
});

test('BRO-5243: 23 shows in window reserve at most 75, so the bulk ceiling is 175 not 135', async () => {
  // Tier-1 host may use the recovery reserve: 174 < 175 proceeds.
  await withBb({ windowShows: 23, live: 174, host: 'wsj.com' }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
  await withBb({ windowShows: 23, live: 175, host: 'www.wsj.com' }, async (call) => {
    await assert.rejects(call, /Browserbase daily cap reached \(175\/175/);
  });
});

test('BRO-5243: non-Tier-1 hosts stop the recovery reserve short of the bulk ceiling', async () => {
  await withBb({ windowShows: 23, live: 144, host: 'talkinbroadway.com' }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
  await withBb({ windowShows: 23, live: 145, host: 'talkinbroadway.com' }, async (call) => {
    await assert.rejects(call, /Browserbase recovery reserve held \(145\/145/);
  });
  // No host at all is treated as non-Tier-1.
  await withBb({ windowShows: 23, live: 145, host: null }, async (call) => {
    await assert.rejects(call, /recovery reserve held/);
  });
});

test('BRO-5243: an explicit recovery run (BROWSERBASE_USE_RESERVE) may spend the reserve for any host', async () => {
  await withBb({ windowShows: 23, live: 160, host: 'deadline.com', useReserve: true }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
});

test('BRO-5243: a quiet week keeps the per-show reserve below the cap', async () => {
  // 3 shows * 5 = 15 reserved: bulk ceiling 235, non-Tier-1 limit 205.
  await withBb({ windowShows: 3, live: 204, host: 'deadline.com' }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
  await withBb({ windowShows: 3, live: 235, host: 'nytimes.com' }, async (call) => {
    await assert.rejects(call, /daily cap reached \(235\/235/);
  });
});

// ---------- BRO-5243 Option B: time-boxed Tier-1 boost (+100 through 2026-10-27 UTC) ----------
const BOOSTED = '2026-10-20T12:00:00Z';

test('BRO-5243 boost: Tier-1 hosts may run 100 past their ceiling while the boost is active', async () => {
  await withBb({ windowShows: 23, live: 274, host: 'www.wsj.com', now: BOOSTED }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
  await withBb({ windowShows: 23, live: 275, host: 'wsj.com', now: BOOSTED }, async (call) => {
    await assert.rejects(call, /Browserbase daily cap reached \(275\/275/);
  });
});

test('BRO-5243 boost: it ends at 2026-10-28T00:00Z with nothing to revert', async () => {
  await withBb({ windowShows: 23, live: 175, host: 'wsj.com', now: '2026-10-27T23:59:00Z' }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
  await withBb({ windowShows: 23, live: 175, host: 'wsj.com', now: '2026-10-28T00:00:00Z' }, async (call) => {
    await assert.rejects(call, /Browserbase daily cap reached \(175\/175/);
  });
});

test('BRO-5243 boost: non-Tier-1 hosts at the bulk ceiling get the non-latching refusal, never the day cap', async () => {
  const { routeCapFromBrowserbaseError } = require('./failed-fetch-policy.js');
  for (const host of ['deadline.com', null]) {
    await withBb({ windowShows: 23, live: 200, host, useReserve: true, now: BOOSTED }, async (call) => {
      const err = await call().then(() => null, (e) => e);
      assert.match(err.message, /recovery reserve held \(200\/175, the rest held for the Tier-1 boost/);
      assert.equal(routeCapFromBrowserbaseError(err.message), 'reserve');
    });
  }
});

test('BRO-5243 boost: opening-night callers keep their slots (raw ceiling rises by the boost too)', async () => {
  await withBb({ windowShows: 23, live: 340, host: 'deadline.com', exemptWorkflow: true, now: BOOSTED }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
  await withBb({ windowShows: 23, live: 350, host: 'deadline.com', exemptWorkflow: true, now: BOOSTED }, async (call) => {
    await assert.rejects(call, /Browserbase daily cap reached \(350\/350/);
  });
});

test('BRO-5243 boost: BROWSERBASE_TIER1_BOOST_DISABLED=true turns it off', async () => {
  const caps = require('./browserbase-caps.js');
  assert.equal(caps.tier1RecoveryBoost('wsj.com', { now: new Date(BOOSTED), env: { BROWSERBASE_TIER1_BOOST_DISABLED: 'true' } }), 0);
  assert.equal(caps.tier1RecoveryBoost('wsj.com', { now: new Date(BOOSTED), env: {} }), 100);
  assert.equal(caps.tier1RecoveryBoost('deadline.com', { now: new Date(BOOSTED), env: {} }), 0);
});

// ---------- Owner-approved caller allowance (Talkin' Broadway probe, 2026-10-19) ----------
const TB_PROBE = 'probe-talkinbroadway-browserbase.js';

test('caller allowance: the probe runs past both reserves while the account is under the raw ceiling', async () => {
  // Bulk limit here is 175 (23 shows) and a non-lane caller is refused at 267.
  await withBb({ windowShows: 23, live: 249, host: 'talkinbroadway.com', caller: TB_PROBE, callerUsed: 2 }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
  await withBb({ windowShows: 23, live: 249, host: 'talkinbroadway.com' }, async (call) => {
    await assert.rejects(call, /Browserbase (recovery reserve held|daily cap reached)/);
  });
});

test('caller allowance: never above the raw daily ceiling (boost included only while active)', async () => {
  await withBb({ windowShows: 23, live: 250, host: 'talkinbroadway.com', caller: TB_PROBE }, async (call) => {
    await assert.rejects(call, /Browserbase daily cap reached \(250\/250/);
  });
  await withBb({ windowShows: 23, live: 267, host: 'talkinbroadway.com', caller: TB_PROBE, now: BOOSTED }, async (call) => {
    assert.equal((await call()).id, 'sess_ok');
  });
});

test('caller allowance: the caller is capped at its own sessions per day', async () => {
  await withBb({ live: 10, host: 'talkinbroadway.com', caller: TB_PROBE, callerUsed: 3 }, async (call, { fetchMock }) => {
    await assert.rejects(call, /Browserbase caller allowance used \(3\/3\)/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

test('caller allowance: an unknown own count or unknown account count refuses', async () => {
  await withBb({ live: 10, host: 'talkinbroadway.com', caller: TB_PROBE, callerUsed: null }, async (call) => {
    await assert.rejects(call, /caller allowance used \(count unknown\)/);
  });
  await withBb({ live: null, host: 'talkinbroadway.com', caller: TB_PROBE, callerUsed: 0 }, async (call) => {
    await assert.rejects(call, /caller allowance used \(count unknown\)/);
  });
});

test('caller allowance: expires, and the kill switch turns it off', async () => {
  const caps = require('./browserbase-caps.js');
  assert.equal(caps.callerAllowance(TB_PROBE, { now: new Date('2026-11-18T23:59:00Z'), env: {} }), 3);
  assert.equal(caps.callerAllowance(TB_PROBE, { now: new Date('2026-11-19T00:00:00Z'), env: {} }), 0);
  assert.equal(caps.callerAllowance(TB_PROBE, { now: new Date('2026-10-20T00:00:00Z'), env: { BROWSERBASE_CALLER_ALLOWANCES_DISABLED: 'true' } }), 0);
  assert.equal(caps.callerAllowance('some-other-script.js', { now: new Date('2026-10-20T00:00:00Z'), env: {} }), 0);
  assert.equal(caps.callerAllowance('constructor', { now: new Date('2026-10-20T00:00:00Z'), env: {} }), 0);
});
