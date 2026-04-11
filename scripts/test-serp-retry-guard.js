#!/usr/bin/env node
/**
 * Tests for SERP retry guard — lifecycle-aware cooldown + hard cap
 *
 * Run: node scripts/test-serp-retry-guard.js
 * No API calls — pure logic verification.
 *
 * RULE: Never copy logic into this file — always require() the real function.
 * Pure decision functions live in scripts/lib/review-guards.js.
 * If production code changes, update review-guards.js; these tests will break
 * and force you to verify the new behavior. That's the point.
 *
 * See: scripts/lib/review-guards.js, sprint-plan-serp-cost-reduction.md
 */

const {
  classifyLifecycle,
  shouldRetryUrlDiscovery,
  recordSerpAttempt,
  MAX_RETRIES_WRONG_CONTENT,
  COOLDOWN_MS,
} = require('./lib/review-guards');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 FAIL: ${label}${detail ? ' \u2014 ' + detail : ''}`);
    failed++;
  }
}

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 FAIL: ${label}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    failed++;
  }
}

// Helpers to build test fixtures with dates relative to now
const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const daysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

// ============================================================
// classifyLifecycle
// ============================================================
console.log('\n=== classifyLifecycle ===\n');

assertEqual(
  classifyLifecycle({ status: 'closed', closingDate: daysAgo(200), category: 'broadway' }),
  'closedOld',
  'closed 200d ago \u2192 closedOld'
);

assertEqual(
  classifyLifecycle({ status: 'closed', closingDate: daysAgo(30), category: 'broadway' }),
  'closedRecent',
  'closed 30d ago \u2192 closedRecent'
);

assertEqual(
  classifyLifecycle({ status: 'previews', openingDate: daysFromNow(20), category: 'broadway' }),
  'previews',
  'status=previews \u2192 previews'
);

assertEqual(
  classifyLifecycle({ status: 'open', openingDate: daysFromNow(10), category: 'broadway' }),
  'previews',
  'open with future openingDate \u2192 previews (safety)'
);

assertEqual(
  classifyLifecycle({ status: 'open', openingDate: daysAgo(5), category: 'broadway' }),
  'openWindow',
  'BW opened 5d ago \u2192 openWindow'
);

assertEqual(
  classifyLifecycle({ status: 'open', openingDate: daysAgo(13), category: 'broadway' }),
  'openWindow',
  'BW opened 13d ago \u2192 openWindow (well inside window)'
);

assertEqual(
  classifyLifecycle({ status: 'open', openingDate: daysAgo(16), category: 'broadway' }),
  'openRecent',
  'BW opened 16d ago \u2192 openRecent (past BW window)'
);

assertEqual(
  classifyLifecycle({ status: 'open', openingDate: daysAgo(18), category: 'west-end' }),
  'openWindow',
  'WE opened 18d ago \u2192 openWindow (21-day window)'
);

assertEqual(
  classifyLifecycle({ status: 'open', openingDate: daysAgo(22), category: 'off-broadway' }),
  'openRecent',
  'OB opened 22d ago \u2192 openRecent (past 21-day window)'
);

assertEqual(
  classifyLifecycle({ status: 'open', openingDate: daysAgo(91), category: 'broadway' }),
  'openMature',
  'open 91d ago \u2192 openMature'
);

assertEqual(
  classifyLifecycle({ status: 'open', category: 'broadway' }),
  'unknown',
  'missing openingDate \u2192 unknown'
);

assertEqual(
  classifyLifecycle({ status: 'closed', category: 'broadway' }),
  'unknown',
  'closed with missing closingDate \u2192 unknown'
);

assertEqual(classifyLifecycle(null), 'unknown', 'null show \u2192 unknown');
assertEqual(classifyLifecycle(undefined), 'unknown', 'undefined show \u2192 unknown');

// ============================================================
// shouldRetryUrlDiscovery — gate logic
// ============================================================
console.log('\n=== shouldRetryUrlDiscovery ===\n');

const closedOldShow = { status: 'closed', closingDate: daysAgo(200), category: 'broadway' };
const openWindowShow = { status: 'open', openingDate: daysAgo(5), category: 'broadway' };
const openMatureShow = { status: 'open', openingDate: daysAgo(120), category: 'broadway' };

// wrong_content + closedOld + no prior attempts \u2192 abandon (max=0)
assertEqual(
  shouldRetryUrlDiscovery(closedOldShow, { incompleteReason: 'wrong_content' }),
  { shouldRetry: false, reason: 'max_retries_reached', updates: { serpDiscoveryAbandoned: true } },
  'wrong_content + closedOld + count=0 \u2192 abandoned immediately'
);

// wrong_content + openWindow + count<3 \u2192 retry
assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'wrong_content', serpRetryCount: 2 }),
  { shouldRetry: true, reason: 'wrong_content_retry' },
  'wrong_content + openWindow + count=2 \u2192 retry (under max 3)'
);

// wrong_content + openWindow + count=3 \u2192 abandon
assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'wrong_content', serpRetryCount: 3 }),
  { shouldRetry: false, reason: 'max_retries_reached', updates: { serpDiscoveryAbandoned: true } },
  'wrong_content + openWindow + count=3 \u2192 abandon (at max)'
);

// serpDiscoveryAbandoned=true short-circuits everything
assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'wrong_content', serpDiscoveryAbandoned: true }),
  { shouldRetry: false, reason: 'abandoned' },
  'abandoned=true short-circuits'
);

// Cooldown active
const cooldownReview = {
  incompleteReason: 'no_url',
  serpRetryAfter: new Date(Date.now() + 3600000).toISOString(),
};
const cooldownResult = shouldRetryUrlDiscovery(openWindowShow, cooldownReview);
assert(
  cooldownResult.shouldRetry === false && cooldownResult.reason === 'cooldown',
  'no_url + cooldown active \u2192 skip'
);
assert(
  cooldownResult.nextAttemptAt === cooldownReview.serpRetryAfter,
  'cooldown response includes nextAttemptAt'
);

// Cooldown expired
assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, {
    incompleteReason: 'no_url',
    serpRetryAfter: new Date(Date.now() - 3600000).toISOString(),
  }),
  { shouldRetry: true, reason: 'no_url_retry' },
  'no_url + cooldown expired \u2192 retry'
);

// fabricatedEntry treated like no_url
assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, { fabricatedEntry: true }),
  { shouldRetry: true, reason: 'fabricated_retry' },
  'fabricatedEntry \u2192 retry (fabricated_retry reason)'
);

// Not gated (incompleteReason is not no_url / wrong_content / fabricated)
assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'paywall' }),
  { shouldRetry: true, reason: 'not_gated' },
  'paywall incompleteReason \u2192 not gated'
);

assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'complete' }),
  { shouldRetry: true, reason: 'not_gated' },
  'complete review \u2192 not gated'
);

// Monotonic cap: previews cap=2, review has count=5 (impossible via normal flow,
// but could happen if show transitions backwards or data is corrupt) \u2192 abandon
assertEqual(
  shouldRetryUrlDiscovery(
    { status: 'previews', openingDate: daysFromNow(5), category: 'broadway' },
    { incompleteReason: 'wrong_content', serpRetryCount: 5 }
  ),
  { shouldRetry: false, reason: 'max_retries_reached', updates: { serpDiscoveryAbandoned: true } },
  'monotonic cap: count=5 on previews (max=2) \u2192 abandon'
);

// Unknown lifecycle defaults safely (max=1)
assertEqual(
  shouldRetryUrlDiscovery(
    { status: 'open' }, // no openingDate \u2192 unknown
    { incompleteReason: 'wrong_content' }
  ),
  { shouldRetry: true, reason: 'wrong_content_retry' },
  'unknown lifecycle + count=0 \u2192 retry (default max=1)'
);

// null review \u2192 pass through (not our concern)
assertEqual(
  shouldRetryUrlDiscovery(openWindowShow, null),
  { shouldRetry: true, reason: 'not_gated' },
  'null review \u2192 not gated'
);

// ============================================================
// recordSerpAttempt — state advancement
// ============================================================
console.log('\n=== recordSerpAttempt ===\n');

// no_url first attempt: count goes 0 \u2192 1, serpRetryAfter set
const rec1 = recordSerpAttempt(openWindowShow, { incompleteReason: 'no_url' });
assert(rec1.serpRetryCount === 1, 'no_url 1st attempt: count=1', JSON.stringify(rec1));
assert(!!rec1.serpRetryAfter, 'no_url 1st attempt: cooldown set');
assert(!rec1.serpDiscoveryAbandoned, 'no_url 1st attempt: not abandoned');

// wrong_content openWindow first attempt: count=1, cooldown set (still under max=3)
const rec2 = recordSerpAttempt(openWindowShow, { incompleteReason: 'wrong_content' });
assert(rec2.serpRetryCount === 1, 'wrong_content openWindow 1st: count=1');
assert(!!rec2.serpRetryAfter, 'wrong_content openWindow 1st: cooldown set');
assert(!rec2.serpDiscoveryAbandoned, 'wrong_content openWindow 1st: not abandoned');

// wrong_content openWindow 3rd attempt (count was 2): count=3, abandoned
const rec3 = recordSerpAttempt(openWindowShow, { incompleteReason: 'wrong_content', serpRetryCount: 2 });
assert(rec3.serpRetryCount === 3, 'wrong_content openWindow 3rd attempt: count=3');
assert(rec3.serpDiscoveryAbandoned === true, 'wrong_content openWindow 3rd attempt: abandoned');
assert(rec3.serpRetryAfter === undefined, 'abandoned entries do not set serpRetryAfter');

// wrong_content closedOld first attempt: abandoned immediately (max=0, so newCount=1 >= 0)
const rec4 = recordSerpAttempt(closedOldShow, { incompleteReason: 'wrong_content' });
assert(rec4.serpRetryCount === 1, 'wrong_content closedOld 1st: count=1 recorded');
assert(rec4.serpDiscoveryAbandoned === true, 'wrong_content closedOld 1st: abandoned immediately');

// Non-gated review: no updates
const rec5 = recordSerpAttempt(openWindowShow, { incompleteReason: 'paywall' });
assertEqual(rec5, {}, 'paywall review: no updates');

// Cooldown value matches the tier table
const recOpenWindow = recordSerpAttempt(openWindowShow, { incompleteReason: 'no_url' });
const openWindowCooldown = new Date(recOpenWindow.serpRetryAfter).getTime() - Date.now();
assert(
  Math.abs(openWindowCooldown - COOLDOWN_MS.openWindow) < 2000,
  `openWindow cooldown \u2248 ${COOLDOWN_MS.openWindow}ms`,
  `got ${openWindowCooldown}ms`
);

const recMature = recordSerpAttempt(openMatureShow, { incompleteReason: 'no_url' });
const matureCooldown = new Date(recMature.serpRetryAfter).getTime() - Date.now();
assert(
  Math.abs(matureCooldown - COOLDOWN_MS.openMature) < 2000,
  `openMature cooldown \u2248 ${COOLDOWN_MS.openMature}ms (14 days)`,
  `got ${matureCooldown}ms`
);

// ============================================================
// Tier table sanity
// ============================================================
console.log('\n=== tier table sanity ===\n');

assert(MAX_RETRIES_WRONG_CONTENT.closedOld === 0, 'closedOld max = 0 (zero retries for frozen windows)');
assert(MAX_RETRIES_WRONG_CONTENT.openWindow === 3, 'openWindow max = 3 (allow opening-night signal pickup)');
assert(MAX_RETRIES_WRONG_CONTENT.previews === 2, 'previews max = 2');
assert(COOLDOWN_MS.closedOld === 90 * DAY, 'closedOld cooldown = 90 days');
assert(COOLDOWN_MS.openWindow === 12 * 3600 * 1000, 'openWindow cooldown = 12h');

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
