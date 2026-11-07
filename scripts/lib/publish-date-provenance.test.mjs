import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isDateRecheckCandidate, needsOpeningWindowDateRecheck } = require('./publish-date-provenance.js');

const show = { openingDate: '2026-05-01' };
const early = { publishDate: '2026-03-01', url: 'https://x.test/a' };
const fine = { publishDate: '2026-05-02', url: 'https://x.test/b' };

test('live predicate selects an early unmarked date', () => {
  assert.equal(isDateRecheckCandidate(early, show), true);
  assert.equal(isDateRecheckCandidate(early, show), needsOpeningWindowDateRecheck(early, show));
});

test('stale needsDateRecheck flag alone no longer selects a file (BRO-5769)', () => {
  assert.equal(isDateRecheckCandidate({ ...fine, needsDateRecheck: true }, show), false);
});

test('flag plus pageDateCandidate stays selected', () => {
  assert.equal(isDateRecheckCandidate({ ...fine, needsDateRecheck: true, pageDateCandidate: '2026-04-01' }, show), true);
});

test('page-read and human-reviewed dates are not candidates', () => {
  assert.equal(isDateRecheckCandidate({ ...early, dateSource: 'html-jsonld' }, show), false);
  assert.equal(isDateRecheckCandidate({ ...early, humanReviewedEarlyPublish: true }, show), false);
  assert.equal(isDateRecheckCandidate(null, show), false);
});

test('BRO-5769 digest row: warns over the limit or when stale, passes when fresh and under', () => {
  const { earlyPublishDatesResults } = require('../health-check.js');
  const now = new Date().toISOString();
  assert.equal(earlyPublishDatesResults({ generatedAt: now, awaiting: 50, attempted: 2, max: 40 })[0].status, 'warn');
  assert.deepEqual(earlyPublishDatesResults({ generatedAt: now, awaiting: 5, attempted: 2, max: 40 }).map(r => r.status), ['pass']);
  assert.deepEqual(earlyPublishDatesResults({ generatedAt: '2020-01-01T00:00:00Z', awaiting: 5, max: 40 }).map(r => r.status), ['warn']);
  assert.deepEqual(earlyPublishDatesResults(null), []);
});
