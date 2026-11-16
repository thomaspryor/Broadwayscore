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
