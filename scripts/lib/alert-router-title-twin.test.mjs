// BRO-7595: the alert router's title fallback must find digest-autofix's
// "BSC Daily: <title>" card for the same row (BRO-7503 duplicated BRO-7455).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findLinearDuplicate } = require('./owner-alert-router.js');

const TITLE = 'Live-data test failing: no West End venue-complex has an unlinked sub-venue slug (tests/unit/venue-complex-live-data.test.mjs)';
const digestCard = { identifier: 'BRO-7455', title: `BSC Daily: ${TITLE}` };
// searchIssues returns the first substring hit: here an older card that quotes the title.
const quoting = { identifier: 'BRO-7000', title: 'Investigate venue tests', description: TITLE };

test('router title fallback matches the digest-autofix "BSC Daily:" card for the same subject', async () => {
  const r = await findLinearDuplicate('live-data-test:x', {
    title: TITLE,
    searchIssuesFn: async (term) => (term === TITLE ? quoting : null),
    listOpenFn: async () => [quoting, digestCard],
  });
  assert.equal(r.matched, true);
  assert.equal(r.identifier, 'BRO-7455');
});

test('a different subject is not a twin', async () => {
  const r = await findLinearDuplicate('live-data-test:y', {
    title: 'Live-data test failing: no Broadway venue-complex has an unlinked sub-venue slug (tests/unit/venue-complex-live-data.test.mjs)',
    searchIssuesFn: async () => null,
    listOpenFn: async () => [digestCard],
  });
  assert.equal(r.matched, false);
});

test('BRO-7595: linear-brain find --exact-title matches across the filer prefix; exact still wins', () => {
  const { findOpenTitleMatch } = require('./card-dedupe.js');
  const open = [
    { identifier: 'BRO-1', title: 'P1: Cron failed: nightly rebuild' },
    { identifier: 'BRO-2', title: 'BSC Daily: breaker TRIPPED: web (2194/1750 reqs)' },
    { identifier: 'BRO-3', title: 'BSC Daily: Cron failed: nightly rebuild' },
  ];
  assert.equal(findOpenTitleMatch(open, 'BSC Daily: Cron failed: nightly rebuild').identifier, 'BRO-3');
  assert.equal(findOpenTitleMatch(open.slice(0, 2), 'BSC Daily: Cron failed: nightly rebuild').identifier, 'BRO-1');
  assert.equal(findOpenTitleMatch(open, 'BSC Daily: Cron failed: weekly rebuild'), null);
  assert.equal(findOpenTitleMatch(open, 'BSC Daily: breaker TRIPPED: web (2301/1750 reqs)'), null);
  assert.equal(findOpenTitleMatch(open, 'BSC Daily: breaker TRIPPED: web (2301/1750 reqs)', { ignoreNumbers: true }).identifier, 'BRO-2');
});
