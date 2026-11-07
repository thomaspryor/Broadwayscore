/**
 * Tests for scripts/lib/commercial-tip-record.js queueTipForReview (BRO-6398):
 * a reader tip is queued as a human-review row in commercial-pending-review.json,
 * never written to commercial.json by process-commercial-tip.js.
 * Run: node --test scripts/lib/commercial-tip-record.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { queueTipForReview, readPendingFile, STALE_REVIEW_STAMPS } = require('./commercial-tip-record.js');
const gate = require('./commercial-apply-gate.js');

const tip = {
  slug: 'hamilton',
  title: 'Hamilton',
  changes: [
    { field: 'capitalization', oldValue: 12000000, newValue: 12500000 },
    { field: 'recouped', oldValue: null, newValue: true },
  ],
  confidence: 'high',
  source: 'https://deadline.com/2026/10/hamilton-recoups',
  issueNumber: 4242,
  reasoning: 'Deadline reports recoupment',
  now: '2026-10-26T22:00:00.000Z',
};

test('queues the tip as a human-review row the daily apply pass holds', () => {
  const pending = { generatedAt: '2026-10-01T00:00:00.000Z', shows: { other: { title: 'Other', confidence: 'low' } } };
  const next = queueTipForReview(pending, tip);
  const row = next.shows.hamilton;
  assert.equal(row.requiresHumanReview, true);
  assert.equal(gate.requiresHumanReview(row), true, 'apply-commercial-pending must see it as a held row');
  assert.equal(gate.hasRecoupedClaim(row), true, 'the recouped claim travels with the row for the person to settle');
  assert.equal(row.capitalization, 12500000);
  assert.equal(row.detectedBy, 'github-tip');
  assert.equal(row.tipIssue, 4242);
  assert.deepEqual(row.sources, [{ type: 'tip', url: tip.source, date: '2026-10-26' }]);
  assert.equal(row.researchedAt, tip.now);
  assert.equal(next.generatedAt, tip.now);
  assert.deepEqual(next.shows.other, pending.shows.other, 'other rows are untouched');
});

test('does not mutate the pending file object it was given', () => {
  const pending = { generatedAt: null, shows: {} };
  const snapshot = JSON.stringify(pending);
  queueTipForReview(pending, tip);
  assert.equal(JSON.stringify(pending), snapshot);
});

test('a tip without a cited source still queues, with no sources', () => {
  const next = queueTipForReview({ shows: {} }, { ...tip, source: null, reasoning: null });
  assert.deepEqual(next.shows.hamilton.sources, []);
  assert.equal(next.shows.hamilton.tipReasoning, null);
});

test('github-tip is not a trusted detectedBy, so its recouped claim never auto-applies', () => {
  const row = queueTipForReview({ shows: {} }, tip).shows.hamilton;
  const show = { slug: 'hamilton', openingDate: '2015-08-06', previewDate: '2015-07-13', status: 'open' };
  assert.equal(gate.isAutoApplyableClaim(row, ['friday-grosses'], show), false);
});

test('merges onto a research row already queued for the show instead of replacing it', () => {
  const prior = {
    title: 'Hamilton', slug: 'hamilton', estimatedRecoupmentPct: 40, confidence: 'medium',
    sources: [{ type: 'article', url: 'https://playbill.com/hamilton-cap', date: '2026-09-01' }],
    researchedAt: '2026-09-01T00:00:00.000Z', backfill: 'BRO-4990', requiresHumanReview: true,
  };
  const row = queueTipForReview({ shows: { hamilton: prior } }, tip).shows.hamilton;
  assert.equal(row.estimatedRecoupmentPct, 40, 'research figure kept');
  assert.equal(row.backfill, 'BRO-4990', 'research hold metadata kept');
  assert.equal(row.capitalization, 12500000, 'tip field wins');
  assert.equal(row.requiresHumanReview, true);
  assert.equal(row.sources.length, 2);
  assert.equal(row.sources[1].type, 'tip');
});

test('a second tip for the same show keeps every issue number that touched the row', () => {
  const once = queueTipForReview({ shows: {} }, tip);
  const twice = queueTipForReview(once, { ...tip, issueNumber: 4300 });
  assert.deepEqual(twice.shows.hamilton.tipIssues, [4242, 4300]);
  assert.equal(twice.shows.hamilton.tipIssue, 4300);
});

test('merging drops the prior row\'s review stamps so the tip is releasable afresh', () => {
  const prior = { title: 'Hamilton', slug: 'hamilton', ownerDigestSentAt: '2026-09-02', autoApplyBlocked: 'old reason', autoApplyBlockedAt: '2026-09-02', truthReview: { verdict: 'reject' }, sourceVerifyAttempts: 3, requiresHumanReview: true };
  const row = queueTipForReview({ shows: { hamilton: prior } }, tip).shows.hamilton;
  for (const k of STALE_REVIEW_STAMPS) assert.equal(k in row, false, k);
  assert.match(row.reason, /GitHub issue #4242/);
});

test('readPendingFile: a missing file is an empty queue, a malformed one throws instead of being replaced', () => {
  const missing = { readFileSync() { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } };
  assert.deepEqual(readPendingFile(missing, '/x.json'), { generatedAt: null, shows: {} });
  const malformed = { readFileSync() { return '{ not json'; } };
  assert.throws(() => readPendingFile(malformed, '/x.json'), SyntaxError);
  const ok = { readFileSync() { return JSON.stringify({ generatedAt: 't', shows: { a: {} } }); } };
  assert.deepEqual(readPendingFile(ok, '/x.json'), { generatedAt: 't', shows: { a: {} } });
});
