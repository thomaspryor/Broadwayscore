// BRO-1325: BTC retroactive confirmation emails — core logic + idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSubmissionsJsonl,
  dedupeLatestByEmail,
  filterUnsent,
  buildConfirmationEmail,
} = require('./lib/btc-confirmation.js');

test('parseSubmissionsJsonl skips rows with no email (market-data rows)', () => {
  const jsonl = [
    JSON.stringify({ email: 'a@x.com', picks: { 'Best Musical': 'Foo' }, submittedAt: '2026-05-24T00:00:00.000Z' }),
    JSON.stringify({ picks: { 'Best Musical': 'Foo' }, source: 'gold-derby-consensus' }),
    '',
    JSON.stringify({ picks: { 'Best Musical': 'Foo' }, source: 'kalshi-market' }),
  ].join('\n');

  const { records, skippedNoEmail } = parseSubmissionsJsonl(jsonl);
  assert.equal(records.length, 1);
  assert.equal(records[0].email, 'a@x.com');
  assert.equal(skippedNoEmail, 2);
});

test('dedupeLatestByEmail keeps the most recent submission per email, case-insensitively', () => {
  const records = [
    { email: 'a@x.com', picks: { p: 'old' }, submittedAt: '2026-05-24T00:00:00.000Z' },
    { email: 'A@X.com', picks: { p: 'new' }, submittedAt: '2026-06-01T00:00:00.000Z' },
    { email: 'b@x.com', picks: { p: 'only' }, submittedAt: '2026-05-25T00:00:00.000Z' },
  ];
  const byEmail = dedupeLatestByEmail(records);
  assert.equal(byEmail.size, 2);
  assert.equal(byEmail.get('a@x.com').picks.p, 'new');
  assert.equal(byEmail.get('b@x.com').picks.p, 'only');
});

test('dedupeLatestByEmail falls back to last-in-file when submittedAt is missing', () => {
  const records = [
    { email: 'a@x.com', picks: { p: 'first' } },
    { email: 'a@x.com', picks: { p: 'second' } },
  ];
  const byEmail = dedupeLatestByEmail(records);
  assert.equal(byEmail.get('a@x.com').picks.p, 'second');
});

test('filterUnsent excludes emails already in the sent-log, case-insensitively', () => {
  const recipients = [{ email: 'a@x.com' }, { email: 'B@X.com' }, { email: 'c@x.com' }];
  const sentSet = new Set(['a@x.com', 'b@x.com']);
  const remaining = filterUnsent(recipients, sentSet);
  assert.deepEqual(remaining.map(r => r.email), ['c@x.com']);
});

test('idempotency: re-running with an updated sent-log sends to nobody twice', () => {
  const recipients = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
  const sentSet = new Set();

  // First "run": nobody sent yet.
  const firstBatch = filterUnsent(recipients, sentSet);
  assert.equal(firstBatch.length, 2);
  for (const r of firstBatch) sentSet.add(r.email.toLowerCase());

  // Second "run" against the same recipient list and the now-populated log.
  const secondBatch = filterUnsent(recipients, sentSet);
  assert.equal(secondBatch.length, 0);
});

test('buildConfirmationEmail does not claim the ceremony is still upcoming', () => {
  const { subject, html } = buildConfirmationEmail({
    email: 'a@x.com',
    picks: { 'Best Musical': 'Foo', 'Best Play': 'Bar' },
    ceremonyYear: 2026,
  });
  assert.match(subject, /2026 Tony Award Picks/);
  assert.ok(!html.includes("We'll email you after the ceremony"));
  assert.ok(html.includes('already taken place'));
  assert.match(html, /You picked 2 categories/);
});

test('buildConfirmationEmail singularizes "category" for a one-pick ballot', () => {
  const { html } = buildConfirmationEmail({ email: 'a@x.com', picks: { 'Best Musical': 'Foo' }, ceremonyYear: 2026 });
  assert.match(html, /You picked 1 category for/);
});
