/**
 * Tests for the fetch retry lifecycle guard (BRO-787) —
 * shouldRetryFetch/recordFetchAttempt in scripts/lib/review-guards.js.
 *
 * Same pathology as the SERP retry guard (scripts/test-serp-retry-guard.js)
 * applied to failed-fetches.json instead of SERP calls: a closed show whose
 * review URL is confirmed dead should stop burning Browserbase/Bright Data/
 * ScrapingBee spend retrying it forever.
 *
 * Per CLAUDE.md rule 15: never copy logic into a test file — always
 * require() the real function. If production code changes, this test
 * breaks and forces verification of the new behavior.
 *
 * Run: node --test scripts/lib/fetch-retry-guard.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldRetryFetch, recordFetchAttempt, getPublicationMoment, isPrePublication } = require('./review-guards.js');

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const daysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString();

// One fixture per classifyLifecycle bucket, mirroring test-serp-retry-guard.js's
// fixtures. category:'broadway' gives a 14-day openWindow.
const previewsShow = { status: 'previews' };
const openWindowShow = { status: 'open', openingDate: daysAgo(5), category: 'broadway' };
const openRecentShow = { status: 'open', openingDate: daysAgo(30), category: 'broadway' };
const openMatureShow = { status: 'open', openingDate: daysAgo(120), category: 'broadway' };
const closedRecentShow = { status: 'closed', closingDate: daysAgo(30) };
const closedOldShow = { status: 'closed', closingDate: daysAgo(200) };
const unknownShow = null;

const LIFECYCLES = [
  { name: 'previews', show: previewsShow, strictMax: 3, lenientMax: 5 },
  { name: 'openWindow', show: openWindowShow, strictMax: 3, lenientMax: 5 },
  { name: 'openRecent', show: openRecentShow, strictMax: 3, lenientMax: 5 },
  { name: 'openMature', show: openMatureShow, strictMax: 3, lenientMax: 5 },
  { name: 'closedRecent', show: closedRecentShow, strictMax: 2, lenientMax: 3 },
  { name: 'closedOld', show: closedOldShow, strictMax: 0, lenientMax: 2 },
  { name: 'unknown', show: unknownShow, strictMax: 3, lenientMax: 5 },
];

const STRICT_COOLDOWN_MS = null; // cooldown table is not strictness-dependent
const COOLDOWN_MS_BY_LIFECYCLE = {
  previews: 6 * 3600 * 1000,
  openWindow: 6 * 3600 * 1000,
  openRecent: 24 * 3600 * 1000,
  openMature: 3 * DAY,
  closedRecent: 7 * DAY,
  closedOld: 30 * DAY,
  unknown: 24 * 3600 * 1000,
};

// ============================================================
// not_gated — nothing to gate
// ============================================================
describe('shouldRetryFetch: not_gated (nothing to gate)', () => {
  test('no failureEntry at all → always allow retry (first attempt)', () => {
    const gate = shouldRetryFetch(closedOldShow, {}, null);
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'not_gated');
  });

  test('undefined failureEntry → always allow retry', () => {
    const gate = shouldRetryFetch(closedOldShow, {}, undefined);
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'not_gated');
  });

  test('null review object → allow retry (defensive default)', () => {
    const gate = shouldRetryFetch(closedOldShow, null, { failureReason: 'url_dead_404', failureCount: 5 });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'not_gated');
  });

  test('non-object review → allow retry', () => {
    const gate = shouldRetryFetch(closedOldShow, 'not-an-object', { failureReason: 'url_dead_404', failureCount: 5 });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'not_gated');
  });
});

// ============================================================
// non-evidence reasons (budget_capped) — never gate
// ============================================================
describe('shouldRetryFetch: non-evidence failure reasons never gate', () => {
  test('budget_capped on a closedOld show with a huge count still allows retry', () => {
    const gate = shouldRetryFetch(closedOldShow, {}, { failureReason: 'budget_capped', failureCount: 50 });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'not_gated');
  });

  test('budget_capped ignores an existing fetchDiscoveryAbandoned=false and any cooldown state', () => {
    const gate = shouldRetryFetch(openMatureShow, { fetchRetryAfter: daysFromNow(10) }, { failureReason: 'budget_capped', failureCount: 10 });
    assert.equal(gate.shouldRetry, true);
  });
});

// ============================================================
// permanent abandoned gate
// ============================================================
describe('shouldRetryFetch: permanent abandoned gate', () => {
  test('fetchDiscoveryAbandoned:true blocks retry regardless of count', () => {
    const gate = shouldRetryFetch(openWindowShow, { fetchDiscoveryAbandoned: true }, { failureReason: 'url_dead_404', failureCount: 1 });
    assert.equal(gate.shouldRetry, false);
    assert.equal(gate.reason, 'abandoned');
  });

  test('fetchDiscoveryAbandoned:false does NOT block (only strict === true blocks)', () => {
    const gate = shouldRetryFetch(openWindowShow, { fetchDiscoveryAbandoned: false }, { failureReason: 'timeout', failureCount: 1 });
    assert.equal(gate.shouldRetry, true);
  });
});

// ============================================================
// cooldown gate
// ============================================================
describe('shouldRetryFetch: cooldown gate', () => {
  test('fetchRetryAfter in the future blocks retry and reports nextAttemptAt', () => {
    const future = daysFromNow(3);
    const gate = shouldRetryFetch(openMatureShow, { fetchRetryAfter: future }, { failureReason: 'timeout', failureCount: 1 });
    assert.equal(gate.shouldRetry, false);
    assert.equal(gate.reason, 'cooldown');
    assert.equal(gate.nextAttemptAt, future);
  });

  test('fetchRetryAfter in the past allows retry', () => {
    const past = daysAgo(1);
    const gate = shouldRetryFetch(openMatureShow, { fetchRetryAfter: past }, { failureReason: 'timeout', failureCount: 1 });
    assert.equal(gate.shouldRetry, true);
  });

  test('malformed fetchRetryAfter date does not block (treated as no cooldown)', () => {
    const gate = shouldRetryFetch(openMatureShow, { fetchRetryAfter: 'not-a-date' }, { failureReason: 'timeout', failureCount: 1 });
    assert.equal(gate.shouldRetry, true);
  });

  test('no fetchRetryAfter field at all allows retry', () => {
    const gate = shouldRetryFetch(openMatureShow, {}, { failureReason: 'timeout', failureCount: 1 });
    assert.equal(gate.shouldRetry, true);
  });
});

// ============================================================
// max-retries-reached — every lifecycle x strictness combination
// ============================================================
describe('shouldRetryFetch: max-retries-reached per lifecycle x failure-class', () => {
  for (const { name, show, strictMax, lenientMax } of LIFECYCLES) {
    test(`${name} / strict (url_dead_404): count===max(${strictMax}) blocks + marks abandoned`, () => {
      const gate = shouldRetryFetch(show, {}, { failureReason: 'url_dead_404', failureCount: strictMax });
      assert.equal(gate.shouldRetry, false);
      assert.equal(gate.reason, 'max_retries_reached');
      assert.deepEqual(gate.updates, { fetchDiscoveryAbandoned: true });
    });

    // closedOld's strict max is 0 — there is no "max-1" attempt to test.
    const strictBelowMaxTest = strictMax === 0 ? test.skip : test;
    strictBelowMaxTest(`${name} / strict (url_dead_404): count===max-1(${strictMax - 1}) still allows`, () => {
      const gate = shouldRetryFetch(show, {}, { failureReason: 'url_dead_404', failureCount: strictMax - 1 });
      assert.equal(gate.shouldRetry, true);
      assert.equal(gate.reason, 'strict_retry');
    });

    test(`${name} / lenient (timeout): count===max(${lenientMax}) blocks + marks abandoned`, () => {
      const gate = shouldRetryFetch(show, {}, { failureReason: 'timeout', failureCount: lenientMax });
      assert.equal(gate.shouldRetry, false);
      assert.equal(gate.reason, 'max_retries_reached');
      assert.deepEqual(gate.updates, { fetchDiscoveryAbandoned: true });
    });

    test(`${name} / lenient (timeout): count===max-1(${lenientMax - 1}) still allows`, () => {
      const gate = shouldRetryFetch(show, {}, { failureReason: 'timeout', failureCount: lenientMax - 1 });
      assert.equal(gate.shouldRetry, true);
      assert.equal(gate.reason, 'lenient_retry');
    });
  }
});

// ============================================================
// strict-reason classification — url_dead_410 and garbage_content also strict
// ============================================================
describe('shouldRetryFetch: strict reason set matches failed-fetch-policy.js', () => {
  test('url_dead_410 is strict — closedOld abandons at count 0', () => {
    const gate = shouldRetryFetch(closedOldShow, {}, { failureReason: 'url_dead_410', failureCount: 0 });
    assert.equal(gate.shouldRetry, false);
    assert.equal(gate.reason, 'max_retries_reached');
  });

  test('garbage_content is strict — closedOld abandons at count 0 (not lenient max 2)', () => {
    const gate = shouldRetryFetch(closedOldShow, {}, { failureReason: 'garbage_content', failureCount: 0 });
    assert.equal(gate.shouldRetry, false);
  });

  test('an arbitrary unrecognized reason falls back to lenient, not strict', () => {
    const gate = shouldRetryFetch(closedOldShow, {}, { failureReason: 'some_new_reason_nobody_wrote_yet', failureCount: 1 });
    assert.equal(gate.shouldRetry, true); // lenient max for closedOld is 2, count 1 < 2
  });
});

// ============================================================
// recordFetchAttempt — cooldown patch per lifecycle
// ============================================================
describe('recordFetchAttempt: cooldown patch matches FETCH_COOLDOWN_MS per lifecycle', () => {
  for (const { name, show, lenientMax } of LIFECYCLES) {
    test(`${name}: still under max → returns fetchRetryAfter ~${COOLDOWN_MS_BY_LIFECYCLE[name] / 3600000}h out`, () => {
      const before = Date.now();
      const patch = recordFetchAttempt(show, {}, { failureReason: 'timeout', failureCount: lenientMax - 1 });
      assert.ok(patch.fetchRetryAfter, 'expected a fetchRetryAfter patch');
      assert.equal(patch.fetchDiscoveryAbandoned, undefined);
      const delta = new Date(patch.fetchRetryAfter).getTime() - before;
      const expected = COOLDOWN_MS_BY_LIFECYCLE[name];
      assert.ok(Math.abs(delta - expected) < 5000, `expected ~${expected}ms cooldown, got ${delta}ms`);
    });
  }
});

// ============================================================
// recordFetchAttempt — abandonment patch on crossing max
// ============================================================
describe('recordFetchAttempt: abandonment patch on crossing max', () => {
  test('strict reason crossing max on closedRecent (max=2) returns fetchDiscoveryAbandoned', () => {
    const patch = recordFetchAttempt(closedRecentShow, {}, { failureReason: 'url_dead_404', failureCount: 2 });
    assert.deepEqual(patch, { fetchDiscoveryAbandoned: true });
  });

  test('lenient reason crossing max on openWindow (max=5) returns fetchDiscoveryAbandoned', () => {
    const patch = recordFetchAttempt(openWindowShow, {}, { failureReason: 'timeout', failureCount: 5 });
    assert.deepEqual(patch, { fetchDiscoveryAbandoned: true });
  });

  test('closedOld strict reason at count 0 (post-increment) abandons immediately — zero cooldown ever set', () => {
    const patch = recordFetchAttempt(closedOldShow, {}, { failureReason: 'url_dead_404', failureCount: 0 });
    assert.deepEqual(patch, { fetchDiscoveryAbandoned: true });
  });
});

// ============================================================
// recordFetchAttempt — non-evidence reasons are a no-op
// ============================================================
describe('recordFetchAttempt: non-evidence reasons do not advance state', () => {
  test('budget_capped returns an empty patch — no cooldown, no abandonment', () => {
    const patch = recordFetchAttempt(closedOldShow, {}, { failureReason: 'budget_capped', failureCount: 50 });
    assert.deepEqual(patch, {});
  });

  test('no failureEntry returns an empty patch', () => {
    const patch = recordFetchAttempt(closedOldShow, {}, null);
    assert.deepEqual(patch, {});
  });
});

// ============================================================
// end-to-end shape: a closed-old show's confirmed-dead URL is gated
// immediately, matching the ticket's headline acceptance criterion
// ============================================================
describe('end-to-end: closed>180d show gets 0 retries on 404, 2 on transient', () => {
  test('404 on a closed-old show is gated on the very first recorded failure', () => {
    const entry = { failureReason: 'url_dead_404', failureCount: 1 };
    const gate = shouldRetryFetch(closedOldShow, {}, entry);
    assert.equal(gate.shouldRetry, false);
  });

  test('a transient failure on the same closed-old show still gets 2 attempts before abandoning', () => {
    const gateAt1 = shouldRetryFetch(closedOldShow, {}, { failureReason: 'timeout', failureCount: 1 });
    assert.equal(gateAt1.shouldRetry, true);
    const gateAt2 = shouldRetryFetch(closedOldShow, {}, { failureReason: 'timeout', failureCount: 2 });
    assert.equal(gateAt2.shouldRetry, false);
  });

  test('an opening-night show (openWindow) keeps the standard 3/5 retry counts, not the tightened closed tiers', () => {
    const deadGate = shouldRetryFetch(openWindowShow, {}, { failureReason: 'url_dead_404', failureCount: 2 });
    assert.equal(deadGate.shouldRetry, true); // 2 < strict max 3
    const transientGate = shouldRetryFetch(openWindowShow, {}, { failureReason: 'timeout', failureCount: 4 });
    assert.equal(transientGate.shouldRetry, true); // 4 < lenient max 5
  });
});

// ============================================================
// Pre-publication failures (BRO-4281)
// ============================================================
// Replays School Girls 2026-09-28: the pinned Talkin' Broadway URL failed at
// 23:15 UTC on opening day and was cooled down until 05:15 UTC, but reviews
// published ~01:00 UTC (openingDate midnight UTC + 25h).

function withNow(iso, fn) {
  const realNow = Date.now;
  const fixed = Date.parse(iso);
  Date.now = () => fixed;
  try { return fn(); } finally { Date.now = realNow; }
}

const schoolGirls = { id: 'school-girls-2026', status: 'previews', openingDate: '2026-09-28', category: 'broadway' };
const PUB_ISO = '2026-09-29T01:00:00.000Z';

describe('getPublicationMoment / isPrePublication', () => {
  test('broadway publishes openingDate + 25h, west-end + 21h', () => {
    assert.equal(new Date(getPublicationMoment(schoolGirls)).toISOString(), PUB_ISO);
    assert.equal(new Date(getPublicationMoment({ ...schoolGirls, category: 'off-broadway' })).toISOString(), PUB_ISO);
    assert.equal(new Date(getPublicationMoment({ ...schoolGirls, category: 'west-end' })).toISOString(), '2026-09-28T21:00:00.000Z');
    assert.equal(new Date(getPublicationMoment({ ...schoolGirls, category: 'off-west-end' })).toISOString(), '2026-09-28T21:00:00.000Z');
  });

  test('local-time anchored: winter (EST/GMT) publishes one hour later in UTC', () => {
    assert.equal(new Date(getPublicationMoment({ openingDate: '2026-12-10', category: 'broadway' })).toISOString(), '2026-12-11T02:00:00.000Z');
    assert.equal(new Date(getPublicationMoment({ openingDate: '2026-12-10', category: 'west-end' })).toISOString(), '2026-12-10T22:00:00.000Z');
    // DST start days (US 2026-03-08, UK 2026-03-29) already use summer time by evening.
    assert.equal(new Date(getPublicationMoment({ openingDate: '2026-03-08', category: 'broadway' })).toISOString(), '2026-03-09T01:00:00.000Z');
    assert.equal(new Date(getPublicationMoment({ openingDate: '2026-03-29', category: 'west-end' })).toISOString(), '2026-03-29T21:00:00.000Z');
  });

  test('winter opening: an 8pm-EST failure is capped at 9pm EST (02:00Z), not 01:00Z', () => {
    const winter = { status: 'previews', openingDate: '2026-12-10', category: 'broadway' };
    const u = withNow('2026-12-11T01:00:00Z', () =>
      recordFetchAttempt(winter, {}, { failureReason: 'fetch_failed', failureCount: 1 }));
    assert.equal(u.fetchRetryAfter, '2026-12-11T02:00:00.000Z');
    assert.equal(u.fetchPrePubFailures, 1);
  });

  test('no parseable openingDate → null / never pre-publication', () => {
    assert.equal(getPublicationMoment({ status: 'previews' }), null);
    assert.equal(getPublicationMoment({ status: 'previews', openingDate: 'TBA' }), null);
    assert.equal(getPublicationMoment(null), null);
    assert.equal(isPrePublication({ status: 'previews' }), false);
  });

  test('window is [publication - 1 day, publication)', () => {
    const pub = Date.parse(PUB_ISO);
    assert.equal(isPrePublication(schoolGirls, pub - DAY - 1), false);
    assert.equal(isPrePublication(schoolGirls, pub - DAY), true);
    assert.equal(isPrePublication(schoolGirls, Date.parse('2026-09-28T23:15:00Z')), true);
    assert.equal(isPrePublication(schoolGirls, pub - 1), true);
    assert.equal(isPrePublication(schoolGirls, pub), false);
  });

  test('closed shows are never pre-publication', () => {
    assert.equal(isPrePublication({ ...schoolGirls, status: 'closed' }, Date.parse('2026-09-28T23:15:00Z')), false);
  });

  test('status open (opening day already flipped) still counts', () => {
    assert.equal(isPrePublication({ ...schoolGirls, status: 'open' }, Date.parse('2026-09-28T23:15:00Z')), true);
  });
});

describe('recordFetchAttempt — pre-publication failures (BRO-4281)', () => {
  test('School Girls replay: cooldown capped at the publication moment, not 05:15', () => {
    const u = withNow('2026-09-28T23:15:00Z', () =>
      recordFetchAttempt(schoolGirls, {}, { failureReason: 'fetch_failed', failureCount: 1 }));
    assert.equal(u.fetchRetryAfter, PUB_ISO);
    assert.equal(u.fetchPrePubFailures, 1);
    assert.equal(u.fetchDiscoveryAbandoned, undefined);
  });

  test('earlier in the window the normal 6h cooldown still applies (spend stays bounded)', () => {
    const u = withNow('2026-09-28T02:00:00Z', () =>
      recordFetchAttempt(schoolGirls, {}, { failureReason: 'fetch_failed', failureCount: 1 }));
    assert.equal(u.fetchRetryAfter, '2026-09-28T08:00:00.000Z');
    assert.equal(u.fetchPrePubFailures, 1);
  });

  test('never abandons in the window, even past the tiered max (strict and lenient)', () => {
    for (const [reason, count] of [['url_dead_404', 3], ['fetch_failed', 5], ['fetch_failed', 9]]) {
      const u = withNow('2026-09-28T23:15:00Z', () =>
        recordFetchAttempt(schoolGirls, { fetchPrePubFailures: 2 }, { failureReason: reason, failureCount: count }));
      assert.equal(u.fetchDiscoveryAbandoned, undefined, `${reason}/${count}`);
      assert.equal(u.fetchPrePubFailures, 3);
      assert.equal(u.fetchRetryAfter, PUB_ISO);
    }
  });

  test('west-end window caps at openingDate + 21h', () => {
    const we = { ...schoolGirls, category: 'west-end' };
    const u = withNow('2026-09-28T19:30:00Z', () =>
      recordFetchAttempt(we, {}, { failureReason: 'fetch_failed', failureCount: 1 }));
    assert.equal(u.fetchRetryAfter, '2026-09-28T21:00:00.000Z');
  });

  test('more than a day before publication → normal behavior (no tally, can abandon)', () => {
    const u = withNow('2026-09-27T23:00:00Z', () =>
      recordFetchAttempt(schoolGirls, {}, { failureReason: 'fetch_failed', failureCount: 1 }));
    assert.equal(u.fetchRetryAfter, '2026-09-28T05:00:00.000Z');
    assert.equal(u.fetchPrePubFailures, undefined);
    const a = withNow('2026-09-27T23:00:00Z', () =>
      recordFetchAttempt(schoolGirls, {}, { failureReason: 'fetch_failed', failureCount: 5 }));
    assert.deepEqual(a, { fetchDiscoveryAbandoned: true });
  });

  test('closed show in the window → normal behavior', () => {
    const closed = { ...schoolGirls, status: 'closed', closingDate: '2026-09-27' };
    const a = withNow('2026-09-28T23:15:00Z', () =>
      recordFetchAttempt(closed, {}, { failureReason: 'fetch_failed', failureCount: 3 }));
    assert.deepEqual(a, { fetchDiscoveryAbandoned: true });
  });

  test('after publication: pre-publication failures do not count toward the max', () => {
    // 5 ledger failures, 4 of them pre-publication → 1 counts; lenient max 5.
    const u = withNow('2026-09-29T02:00:00Z', () =>
      recordFetchAttempt(schoolGirls, { fetchPrePubFailures: 4 }, { failureReason: 'fetch_failed', failureCount: 5 }));
    assert.equal(u.fetchDiscoveryAbandoned, undefined);
    assert.equal(u.fetchPrePubFailures, undefined);
    assert.equal(u.fetchRetryAfter, '2026-09-29T08:00:00.000Z');
    // Post-publication budget exhausted: 9 failures, 4 pre-publication → 5 counts.
    const a = withNow('2026-09-29T02:00:00Z', () =>
      recordFetchAttempt(schoolGirls, { fetchPrePubFailures: 4 }, { failureReason: 'fetch_failed', failureCount: 9 }));
    assert.deepEqual(a, { fetchDiscoveryAbandoned: true });
  });

  test('after publication with no tally: identical to today (abandons at max)', () => {
    const a = withNow('2026-09-29T02:00:00Z', () =>
      recordFetchAttempt(schoolGirls, {}, { failureReason: 'fetch_failed', failureCount: 5 }));
    assert.deepEqual(a, { fetchDiscoveryAbandoned: true });
  });

  test('simulated opening eve: a persistently failing URL gets a bounded number of attempts', () => {
    // Retry as soon as each cooldown expires from pub-1d until pub.
    let t = Date.parse(PUB_ISO) - DAY;
    let review = {};
    let failureCount = 0;
    let attempts = 0;
    while (t < Date.parse(PUB_ISO)) {
      failureCount++;
      attempts++;
      const u = withNow(new Date(t).toISOString(), () =>
        recordFetchAttempt(schoolGirls, review, { failureReason: 'fetch_failed', failureCount }));
      assert.equal(u.fetchDiscoveryAbandoned, undefined);
      review = { ...review, ...u };
      t = Date.parse(u.fetchRetryAfter);
    }
    assert.equal(attempts, 4); // 6h cooldown over 24h
    assert.equal(review.fetchRetryAfter, PUB_ISO);
    // ...and the full post-publication budget is still available.
    const gate = withNow('2026-09-29T01:00:00Z', () =>
      shouldRetryFetch(schoolGirls, review, { failureReason: 'fetch_failed', failureCount }));
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'lenient_retry');
  });
});

describe('shouldRetryFetch — subtracts fetchPrePubFailures (BRO-4281)', () => {
  test('pre-publication failures leave the budget untouched', () => {
    const gate = shouldRetryFetch(openWindowShow, { fetchPrePubFailures: 5 }, { failureReason: 'fetch_failed', failureCount: 5 });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'lenient_retry');
  });

  test('a tally larger than the ledger count clamps to zero, never negative', () => {
    const gate = shouldRetryFetch(openWindowShow, { fetchPrePubFailures: 9 }, { failureReason: 'url_dead_404', failureCount: 2 });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'strict_retry');
  });

  test('post-publication failures still hit the max with the same label', () => {
    const gate = shouldRetryFetch(openWindowShow, { fetchPrePubFailures: 2 }, { failureReason: 'url_dead_404', failureCount: 5 });
    assert.equal(gate.shouldRetry, false);
    assert.equal(gate.reason, 'max_retries_reached');
    assert.deepEqual(gate.updates, { fetchDiscoveryAbandoned: true });
  });
});
