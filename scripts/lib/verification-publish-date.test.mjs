// BRO-4884: the verifier was told historical reviews were written today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verificationPublishDate, closedLongAgo } = require('./verification-publish-date.js');

const hadestown = { id: 'hadestown-west-end-2018', openingDate: '2018-11-02', closingDate: '2019-01-26' };
const current = { id: 'new-show-2026', openingDate: '2026-10-10', closingDate: null };

test('a stored or page-derived date wins', () => {
  assert.equal(verificationPublishDate({ storedDate: '2018-11-14', derivedDate: '2018-11-15', show: hadestown, today: '2026-10-11' }), '2018-11-14');
  assert.equal(verificationPublishDate({ storedDate: null, derivedDate: '2018-11-15', show: hadestown, today: '2026-10-11' }), '2018-11-15');
});

test('an undated stub of a long-closed show gets no date, never today', () => {
  assert.equal(verificationPublishDate({ storedDate: null, derivedDate: null, textFetchedAt: '2026-10-11T17:40:19Z', show: hadestown, today: '2026-10-11' }), null);
});

test('opening night keeps the today fallback (fresh stubs of a current show)', () => {
  assert.equal(verificationPublishDate({ storedDate: null, derivedDate: null, textFetchedAt: null, show: current, today: '2026-10-11' }), '2026-10-11');
  assert.equal(verificationPublishDate({ storedDate: null, derivedDate: null, textFetchedAt: '2026-10-11T03:00:00Z', show: current, today: '2026-10-11' }), '2026-10-11');
  // Closed within the 60-day grace: late reviews still arrive.
  assert.equal(verificationPublishDate({ storedDate: null, derivedDate: null, show: { closingDate: '2026-09-01' }, today: '2026-10-11' }), '2026-10-11');
  // No show metadata at all: unchanged behaviour.
  assert.equal(verificationPublishDate({ storedDate: null, derivedDate: null, show: null, today: '2026-10-11' }), '2026-10-11');
});

test('closedLongAgo', () => {
  assert.equal(closedLongAgo(hadestown, '2026-10-11'), true);
  assert.equal(closedLongAgo(current, '2026-10-11'), false);
  assert.equal(closedLongAgo({ closingDate: '2026-08-20' }, '2026-10-11'), false);
  assert.equal(closedLongAgo({ closingDate: 'TBA' }, '2026-10-11'), false);
});

// Wiring: the collector and both reverify scripts must route through the helper.
test('callers use verificationPublishDate, not a raw today/textFetchedAt fallback', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const f of ['scripts/collect-review-texts.js', 'scripts/reverify-stale-cv-promoted.js', 'scripts/reverify-nulled-cv-promoted.js']) {
    const src = readFileSync(root + f, 'utf8');
    assert.match(src, /publishDate: verificationPublishDate\(/, f);
    assert.doesNotMatch(src, /publishDate: (reviewData|data)\.publishDate \|\| (reviewData|data)\.textFetchedAt/, f);
  }
});
