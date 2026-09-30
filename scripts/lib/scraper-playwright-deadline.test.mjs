// BRO-4401: the Playwright tier is raced against an end-to-end deadline.
// page.goto() has a 30s timeout of its own, yet run 36655690883 (the first
// fetch-all-image-formats run with a real browser) sat 2.5 hours on one
// google.com/search fetch with a live chrome-headless-shell orphan. Whatever
// step hung, the tier as a whole now cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { raceTierAgainstDeadline, PLAYWRIGHT_TIER_DEADLINE_MS } = require('./scraper.js');

test('a tier that resolves in time wins the race with its own value', async () => {
  const r = await raceTierAgainstDeadline(Promise.resolve({ content: '<html>', source: 'playwright' }), 200);
  assert.deepEqual(r, { content: '<html>', source: 'playwright' });
});

test('a tier that never settles loses to the deadline as { timedOut: true }', async () => {
  const never = new Promise(() => {});
  const r = await raceTierAgainstDeadline(never, 30);
  assert.deepEqual(r, { timedOut: true });
});

test('a rejecting tier still rejects (the caller\'s existing catch path handles it)', async () => {
  await assert.rejects(raceTierAgainstDeadline(Promise.reject(new Error('boom')), 200), /boom/);
});

test('the shipped deadline is bounded: longer than a goto timeout, far shorter than the run budget', () => {
  assert.ok(PLAYWRIGHT_TIER_DEADLINE_MS > 30 * 1000, 'must exceed page.goto()\'s own 30s timeout or every slow page would be abandoned');
  assert.ok(PLAYWRIGHT_TIER_DEADLINE_MS <= 5 * 60 * 1000, 'a stuck tier must give up well inside any workflow budget');
});
