// BRO-5395: the showNotMentioned flag audit names what would still exclude a
// file once that flag is cleared, so a hand sort sees the second flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stillExcludedBy } = require('./still-excluded-by.js');

const show = { id: 'a-show-west-end-2025', title: 'A Show', openingDate: '2025-05-01', status: 'open' };
const base = { showId: show.id, outletId: 'guardian', criticName: 'A Critic', publishDate: '2025-05-02', contentTier: 'complete', fullText: 'x'.repeat(1200), showNotMentioned: true };

test('a clean row is excluded by nothing once showNotMentioned is cleared', () => {
  assert.equal(stillExcludedBy(base, show, `/x/${show.id}/guardian--a-critic.json`), null);
});

test('a second flag is reported', () => {
  assert.equal(stillExcludedBy({ ...base, wrongShow: true }, show, `/x/${show.id}/guardian--a-critic.json`), 'wrongShow');
});
