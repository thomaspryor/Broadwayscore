// BRO-3432: the weekly geo-bot audit's PostHog leg (scripts/lib/posthog-geo-bots.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  POSTHOG_BOT_THRESHOLDS, buildPosthogGeoQuery, parsePosthogGeoRows, isPosthogBotGeo,
  partitionByKnown, buildGeoBotAlerts, formatPosthogStats, ROW_LIMIT,
} = require('./posthog-geo-bots.js');
// data/audit/known-bot-geos.json knownBots as of 2026-09-15 (inline: a
// scripts/lib test may not read files outside scripts/lib, audit-test-yml-lib-deps).
const KNOWN_BOTS = ['Singapore', 'China', 'Vietnam', 'Hong Kong'];

// [country, sessions, users, pageviews] — the shape phQuery returns.
const ROWS = [
  ['United States', 4200, 3100, 9800],   // real users: repeats + multi-page
  ['Hong Kong', 741, 741, 741],          // BRO-3419 signature: sessions == users, 1 page
  ['Ireland', 120, 119, 124],            // new bot: 0.99 users/session, 1.03 pv/session
  ['Germany', 90, 90, 90],               // bot-shaped but under the 100-session floor
  ['Canada', 300, 298, 400],             // 1.33 pages/session: real
  ['Brazil', 200, 150, 200],             // 0.75 users/session: repeat visitors
  ['', 500, 500, 500],                   // unknown geo is never flagged
];

test('thresholds match the card: >=100 sessions, >=0.98 users/session, <=1.05 pv/session', () => {
  assert.deepEqual(POSTHOG_BOT_THRESHOLDS, { minSessions: 100, minUsersPerSession: 0.98, maxPageviewsPerSession: 1.05 });
});

test('flags exactly the bot-shaped countries', () => {
  const flagged = parsePosthogGeoRows(ROWS).filter((r) => isPosthogBotGeo(r)).map((r) => r.country);
  assert.deepEqual(flagged, ['Hong Kong', 'Ireland']);
});

test('boundaries are inclusive and zero sessions never divides by zero', () => {
  const [edge] = parsePosthogGeoRows([['Edge', 100, 98, 105]]);
  assert.equal(isPosthogBotGeo(edge), true);
  const [under] = parsePosthogGeoRows([['Under', 100, 97, 105]]);
  assert.equal(isPosthogBotGeo(under), false);
  const [over] = parsePosthogGeoRows([['Over', 100, 98, 106]]);
  assert.equal(isPosthogBotGeo(over), false);
  const [zero] = parsePosthogGeoRows([['Zero', 0, 0, 0]]);
  assert.equal(zero.usersPerSession, 0);
  assert.equal(isPosthogBotGeo(zero), false);
});

test('known bot geos suppress Hong Kong; Ireland is new', () => {
  const bots = parsePosthogGeoRows(ROWS).filter((r) => isPosthogBotGeo(r));
  const { newBots, knownSeen } = partitionByKnown(bots, new Set(KNOWN_BOTS));
  assert.deepEqual(knownSeen.map((b) => b.country), ['Hong Kong']);
  assert.deepEqual(newBots.map((b) => b.country), ['Ireland']);
});

test('alerts: one routeAlert payload per new country, GA4 conditionKey, both sources merged', () => {
  const alerts = buildGeoBotAlerts(
    [{ country: 'Ireland', text: 'ga-stats' }, { country: 'Peru', text: 'ga-only' }],
    [{ country: 'Ireland', text: 'ph-stats' }, { country: 'Kenya', text: 'ph-only' }],
    'ga-thresholds',
  );
  assert.deepEqual(alerts.map((a) => a.conditionKey), ['geo-bots:Ireland', 'geo-bots:Peru', 'geo-bots:Kenya']);
  for (const a of alerts) {
    assert.equal(a.disposition, 'digest');
    assert.equal(a.severity, 'warning');
    assert.match(a.description, /known-bot-geos\.json/);
  }
  const ie = alerts[0];
  assert.match(ie.description, /in GA4 \+ PostHog/);
  assert.match(ie.description, /GA4: ga-stats/);
  assert.match(ie.description, /PostHog: ph-stats/);
  assert.match(alerts[2].description, /in PostHog\./);
  assert.doesNotMatch(alerts[2].description, /GA4:/);
  assert.deepEqual(buildGeoBotAlerts([], [], 'x'), []);
});

test('HogQL query: 7-day pageview window, owner excluded, explicit LIMIT, no Real Users lens', () => {
  const q = buildPosthogGeoQuery(7);
  assert.match(q, /event = '\$pageview'/);
  assert.match(q, /interval 7 day/);
  assert.match(q, /is_owner/);
  assert.match(q, /LIMIT \d+/);
  assert.doesNotMatch(q, /NOT IN \('SG'/); // known bot geos must stay visible
  assert.match(buildPosthogGeoQuery('nonsense'), /interval 7 day/);
});

test('country code is carried into the alert stats; null name maps to (unknown)', () => {
  const [hk, nul] = parsePosthogGeoRows([['Hong Kong', 741, 741, 741, 'HK'], [null, 300, 300, 300, null]]);
  assert.equal(hk.countryCode, 'HK');
  assert.match(formatPosthogStats(hk), /^\[HK\] 741 PostHog sessions/);
  assert.equal(nul.country, '(unknown)');
  assert.equal(isPosthogBotGeo(nul), false);
});

test('a result page that reaches the LIMIT is refused, not silently partial', () => {
  const rows = Array.from({ length: ROW_LIMIT }, (_, i) => [`C${i}`, 1, 1, 1, '']);
  assert.throws(() => parsePosthogGeoRows(rows), /row limit/);
});
