/**
 * BRO-5989 RECHECK-AFTER probe: reads LIVE PostHog data, red until each arm of
 * the related-shows-position A/B has the pre-registered minimum of exposed
 * people (docs/experiments/related-shows-position.md). Red is the claim being
 * disproven, not a code regression, so it stays out of CI (EXEMPT_NEVER_CI).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const CHECKABLE_FROM = Date.parse('2026-11-09T00:00:00Z');
const MIN_PER_ARM = 906;
const CUTOVER = '2026-10-23 02:11:00';

test('related-shows-position has the minimum exposed people per arm', {
  skip: Date.now() < CHECKABLE_FROM && 'not checkable before 2026-11-09',
}, async () => {
  const { POSTHOG_PERSONAL_API_KEY: key, POSTHOG_PROJECT_ID: pid } = process.env;
  assert.ok(key && pid, 'POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are required');
  const q = `SELECT properties.variant AS arm, count(DISTINCT person_id) AS n FROM events WHERE event = 'related_shows_ab_exposed' AND timestamp > toDateTime('${CUTOVER}') GROUP BY arm`;
  const r = await fetch(`https://us.posthog.com/api/projects/${pid}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }),
  });
  assert.ok(r.ok, `PostHog query failed: ${r.status}`);
  const rows = Object.fromEntries((await r.json()).results);
  for (const arm of ['control', 'compact-after-reviews']) {
    assert.ok((rows[arm] || 0) >= MIN_PER_ARM, `${arm}: ${rows[arm] || 0} < ${MIN_PER_ARM} exposed people`);
  }
});
