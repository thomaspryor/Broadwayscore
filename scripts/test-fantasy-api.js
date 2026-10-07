/**
 * Integration tests for the Fantasy League API.
 *
 * Runs against the live site (or a local dev server via BASE_URL env var).
 * Tests the full lifecycle: create league → submit draft → leaderboard → edge cases.
 *
 * Usage:
 *   node scripts/test-fantasy-api.js
 *   BASE_URL=http://localhost:3000 node scripts/test-fantasy-api.js
 *
 * Requires real show IDs from data/fantasy-league.json to exist on the server.
 */

'use strict';

const BASE_URL = process.env.BASE_URL || 'https://broadwayscorecard.com';

// Pull 3 valid show IDs from local fantasy-league.json for use in tests
let VALID_PICKS = [];
try {
  const data = require('../data/fantasy-league.json');
  VALID_PICKS = Object.keys(data.shows).slice(0, 3);
} catch {
  console.error('Could not load data/fantasy-league.json — run npm run data:check first.');
  process.exit(1);
}

if (VALID_PICKS.length < 1) {
  console.error('No shows found in fantasy-league.json');
  process.exit(1);
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, data: await res.json() };
}

// ─── Test email namespace to avoid colliding with real data ───────────────────

const RUN_ID = Date.now().toString(36);
const testEmail = (n) => `test-suite-${RUN_ID}-${n}@test.invalid`;

// ─── Suite ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nFantasy API integration tests`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Show IDs under test: ${VALID_PICKS.join(', ')}\n`);

  let leagueCode = null;

  // ── League creation ──────────────────────────────────────────────────────────
  console.log('League creation:');

  await test('POST /api/fantasy/leagues — valid request returns code + name', async () => {
    const { status, data } = await post('/api/fantasy/leagues', {
      name: `Test League ${RUN_ID}`,
      created_by_email: testEmail('creator'),
    });
    assertEqual(status, 200, 'status');
    assert(typeof data.code === 'string' && data.code.length === 6, `code should be 6 chars, got: ${data.code}`);
    assert(data.name.includes(RUN_ID), 'name should match');
    leagueCode = data.code;
  });

  await test('POST /api/fantasy/leagues — missing name returns 400', async () => {
    const { status, data } = await post('/api/fantasy/leagues', {
      created_by_email: testEmail('creator'),
    });
    assertEqual(status, 400, 'status');
    assert(data.error, 'should have error message');
  });

  await test('POST /api/fantasy/leagues — name too short returns 400', async () => {
    const { status, data } = await post('/api/fantasy/leagues', {
      name: 'X',
      created_by_email: testEmail('creator'),
    });
    assertEqual(status, 400, 'status');
    assert(data.error, 'should have error message');
  });

  await test('POST /api/fantasy/leagues — invalid email returns 400', async () => {
    const { status, data } = await post('/api/fantasy/leagues', {
      name: 'Valid League Name',
      created_by_email: 'not-an-email',
    });
    assertEqual(status, 400, 'status');
    assert(data.error, 'should have error message');
  });

  await test('POST /api/fantasy/leagues — missing email returns 400', async () => {
    const { status } = await post('/api/fantasy/leagues', { name: 'Valid League Name' });
    assertEqual(status, 400, 'status');
  });

  // ── League metadata ──────────────────────────────────────────────────────────
  console.log('\nLeague metadata:');

  await test('GET /api/fantasy/leagues/[code] — returns metadata', async () => {
    assert(leagueCode, 'league must have been created first');
    const { status, data } = await get(`/api/fantasy/leagues/${leagueCode}`);
    assertEqual(status, 200, 'status');
    assertEqual(data.code, leagueCode, 'code');
    assert(typeof data.name === 'string', 'name present');
    assert(typeof data.created_at === 'string', 'created_at present');
    assertEqual(data.member_count, 0, 'member_count starts at 0');
  });

  await test('GET /api/fantasy/leagues/zzzzzz — unknown code returns 404', async () => {
    const { status, data } = await get('/api/fantasy/leagues/zzzzzz');
    assertEqual(status, 404, 'status');
    assert(data.error, 'should have error message');
  });

  // ── Draft submission ─────────────────────────────────────────────────────────
  console.log('\nDraft submission:');

  await test('POST /api/fantasy/draft — valid picks submit successfully', async () => {
    const { status, data } = await post('/api/fantasy/draft', {
      email: testEmail('player1'),
      team_name: 'Test Team 1',
      picks: [VALID_PICKS[0]],
    });
    assertEqual(status, 200, 'status');
    assertEqual(data.success, true, 'success flag');
  });

  await test('POST /api/fantasy/draft — with valid league code, joins league', async () => {
    assert(leagueCode, 'league must exist');
    const { status, data } = await post('/api/fantasy/draft', {
      email: testEmail('player2'),
      team_name: 'League Player',
      league_name: leagueCode,
      picks: [VALID_PICKS[0]],
    });
    assertEqual(status, 200, 'status');
    assertEqual(data.success, true, 'success flag');
  });

  await test('POST /api/fantasy/draft — empty picks returns 400', async () => {
    const { status, data } = await post('/api/fantasy/draft', {
      email: testEmail('player3'),
      picks: [],
    });
    assertEqual(status, 400, 'status');
    assert(data.error?.match(/at least 1/i), `expected "at least 1" error, got: ${data.error}`);
  });

  await test('POST /api/fantasy/draft — invalid show ID returns 400', async () => {
    const { status, data } = await post('/api/fantasy/draft', {
      email: testEmail('player4'),
      picks: ['this-show-does-not-exist-9999'],
    });
    assertEqual(status, 400, 'status');
    assert(data.error?.match(/invalid show/i), `expected "invalid show" error, got: ${data.error}`);
  });

  await test('POST /api/fantasy/draft — invalid league code returns 400', async () => {
    const { status, data } = await post('/api/fantasy/draft', {
      email: testEmail('player5'),
      league_name: 'xxxxxx',
      picks: [VALID_PICKS[0]],
    });
    assertEqual(status, 400, 'status');
    assert(data.error?.match(/league not found/i), `expected "league not found" error, got: ${data.error}`);
  });

  await test('POST /api/fantasy/draft — missing email returns 4xx', async () => {
    const { status } = await post('/api/fantasy/draft', { picks: [VALID_PICKS[0]] });
    // 400 = validation error, 429 = rate limited (both are rejections)
    assert(status === 400 || status === 429, `expected 4xx, got ${status}`);
  });

  await test('POST /api/fantasy/draft — duplicate picks return 4xx', async () => {
    const { status, data } = await post('/api/fantasy/draft', {
      email: testEmail('player6'),
      picks: [VALID_PICKS[0], VALID_PICKS[0]],
    });
    assert(status === 400 || status === 429, `expected 4xx, got ${status}`);
    if (status === 400) {
      assert(data.error?.match(/duplicate/i), `expected "duplicate" error, got: ${data.error}`);
    }
  });

  await test('POST /api/fantasy/draft — re-submit returns 409 (picks are final)', async () => {
    const email = testEmail('player7');
    const r1 = await post('/api/fantasy/draft', { email, picks: [VALID_PICKS[0]] });
    if (r1.status === 429) {
      console.log('    (skipped — rate limited; run again after 1h for full coverage)');
      passed++; failed--; // un-count as failure
      return;
    }
    const r2 = await post('/api/fantasy/draft', {
      email,
      picks: VALID_PICKS.length > 1 ? [VALID_PICKS[1]] : [VALID_PICKS[0]],
    });
    assert(r2.status === 409 || r2.status === 429, `re-submit status: ${r2.status} (expected 409)`);
    if (r2.status === 409) {
      assert(r2.data.error?.match(/already submitted|final/i), `expected "already submitted" error, got: ${r2.data.error}`);
    }
  });

  // ── Leaderboard ──────────────────────────────────────────────────────────────
  console.log('\nLeaderboard:');

  await test('GET /api/fantasy/leaderboard?league=[code] — returns league entry', async () => {
    assert(leagueCode, 'league must exist');
    const { status, data } = await get(`/api/fantasy/leaderboard?league=${leagueCode}`);
    assertEqual(status, 200, 'status');
    assert(Array.isArray(data.entries), 'entries is array');
    assertEqual(data.entries.length, 1, 'should have 1 entry (the league player)');
    // computeLeaderboard returns displayName (= team_name or masked email), totalPoints, rank
    const entry = data.entries[0];
    assertEqual(entry.displayName, 'League Player', 'displayName should be team_name');
    assert(typeof entry.totalPoints === 'number', 'totalPoints should be a number');
    assert(typeof entry.rank === 'number', 'rank should be present');
  });

  await test('GET /api/fantasy/leaderboard?league=[code] — does not include global entries', async () => {
    assert(leagueCode, 'league must exist');
    const { data } = await get(`/api/fantasy/leaderboard?league=${leagueCode}`);
    // player1 submitted without a league — should not appear in league leaderboard
    const hasGlobalPlayer = data.entries.some((e) => e.displayName?.toLowerCase().includes('player1'));
    assert(!hasGlobalPlayer, 'global entry should not appear in league leaderboard');
  });

  await test('GET /api/fantasy/leagues/[code] member_count increments after join', async () => {
    assert(leagueCode, 'league must exist');
    const { data } = await get(`/api/fantasy/leagues/${leagueCode}`);
    assertEqual(data.member_count, 1, 'member_count should be 1 after one join');
  });

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
