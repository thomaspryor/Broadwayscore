// BRO-2735: pure _pending health decisions (age guard window, unrecoverable
// classification, pending-record merge that keeps firstSeenAt, rebuild).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const h = require('./pending-review-health.js');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const H = 3600e3;

test('post-opening window is signed 0..7d, not Math.abs', () => {
  assert.equal(h.isInPostOpeningWindow({ openingDate: '2026-10-12' }, NOW), true); // opening day
  assert.equal(h.isInPostOpeningWindow({ openingDate: '2026-10-06' }, NOW), true); // day 6.5
  assert.equal(h.isInPostOpeningWindow({ openingDate: '2026-10-05' }, NOW), false); // day 7.5
  assert.equal(h.isInPostOpeningWindow({ openingDate: '2026-10-14' }, NOW), false); // 2 days BEFORE opening
  assert.equal(h.isInPostOpeningWindow({ openingDate: null }, NOW), false);
  assert.equal(h.isInPostOpeningWindow(undefined, NOW), false);
});

test('stalePendingReason: firstSeenAt clock, mtime fallback, threshold, junk exempt', () => {
  const show = { openingDate: '2026-10-10' };
  const old = new Date(NOW - 30 * H).toISOString();
  assert.deepEqual(h.stalePendingReason({ data: { firstSeenAt: old }, show, nowMs: NOW, staleHours: 24 }),
    { ageHours: 30, clock: 'firstSeenAt' });
  assert.equal(h.stalePendingReason({ data: { firstSeenAt: old }, show, nowMs: NOW, staleHours: 48 }), null);
  assert.equal(h.stalePendingReason({ data: {}, show, mtimeMs: NOW - 25 * H, nowMs: NOW }).clock, 'mtime');
  assert.equal(h.stalePendingReason({ data: { firstSeenAt: old, rssIdentityRejected: true }, show, nowMs: NOW }), null);
  assert.equal(h.stalePendingReason({ data: { firstSeenAt: old }, show: { openingDate: '2026-10-20' }, nowMs: NOW }), null);
});

test('unrecoverable = zero text AND no byline (stored or extracted)', () => {
  assert.equal(h.isUnrecoverablePendingStub({ criticName: 'Unknown', fullText: null }, null), true);
  assert.equal(h.isUnrecoverablePendingStub({ criticName: 'Unknown', fullText: '  ' }, 'Unknown'), true);
  assert.equal(h.isUnrecoverablePendingStub({ criticName: 'Unknown', fullText: null }, 'Jane Critic'), false);
  assert.equal(h.isUnrecoverablePendingStub({ criticName: 'Unknown', fullText: 'real body' }, null), false);
  assert.equal(h.isUnrecoverablePendingStub({ criticName: 'Sarah Hemming', fullText: null }, null), false);
});

test('mergePendingRecord keeps firstSeenAt + replay bookkeeping across re-discovery (gather-reviews writer)', () => {
  const first = h.mergePendingRecord(null, { url: 'u', criticName: 'Unknown' }, '2026-10-10T00:00:00Z');
  assert.equal(first.firstSeenAt, '2026-10-10T00:00:00Z');
  assert.equal(first.pendingReason, 'no-byline');
  const existing = { ...first, promoteSkippedReason: 'not this show', fullText: 'recovered body', contentTier: 'complete' };
  const again = h.mergePendingRecord(existing, { url: 'u', criticName: 'Unknown', fullText: null, contentTier: 'stub' }, '2026-10-12T00:00:00Z');
  assert.equal(again.firstSeenAt, '2026-10-10T00:00:00Z', 'clock not reset on re-discovery');
  assert.equal(again.promoteSkippedReason, 'not this show');
  assert.equal(again.fullText, 'recovered body', 'textless re-discovery does not wipe a recovered body');
  assert.equal(again.contentTier, 'complete');
});

test('gather-reviews pending writer goes through mergePendingRecord (no from-scratch rewrite)', () => {
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /mergePendingRecord\(existingPending, review\)/);
  assert.doesNotMatch(src, /JSON\.stringify\(\{ \.\.\.review, pendingReason: 'no-byline' \}/);
});

test('buildRefetchedPendingRecord returns a new object from identity fields + patch', () => {
  const stub = { showId: 's', outletId: 'o', url: 'u', criticName: 'Unknown', dtliExcerpt: 'e', junk: 1, fullText: null };
  const out = h.buildRefetchedPendingRecord(stub, { fullText: 'body', contentTier: 'complete' }, '2026-10-12T00:00:00Z');
  assert.notEqual(out, stub);
  assert.equal(stub.fullText, null, 'stub not mutated');
  assert.equal(out.junk, 1, 'all stub fields are carried (exclusion flags, provenance)');
  assert.equal(out.dtliExcerpt, 'e');
  assert.equal(out.fullText, 'body');
  assert.equal(out.pendingRefetchedAt, '2026-10-12T00:00:00Z');
  assert.equal(out.firstSeenAt, '2026-10-12T00:00:00Z');
});

test('findStalePendingEntries walks only in-window shows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2735-health-'));
  const mk = (id, data) => {
    fs.mkdirSync(path.join(root, '_pending', id), { recursive: true });
    fs.writeFileSync(path.join(root, '_pending', id, 'x--1.json'), JSON.stringify(data));
  };
  const old = new Date(NOW - 40 * H).toISOString();
  mk('a', { outletId: 'x', url: 'u', firstSeenAt: old });
  mk('b', { outletId: 'x', url: 'u', firstSeenAt: old });
  const hits = h.findStalePendingEntries({ reviewTextsRoot: root, nowMs: NOW,
    shows: [{ id: 'a', openingDate: '2026-10-11' }, { id: 'b', openingDate: '2026-11-01' }] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].showId, 'a');
  assert.equal(hits[0].zeroText, true);
});

test('resolveStaleHours honours STALE_PENDING_HOURS', () => {
  assert.equal(h.resolveStaleHours({}), h.DEFAULT_STALE_HOURS);
  assert.equal(h.resolveStaleHours({ STALE_PENDING_HOURS: '6' }), 6);
  assert.equal(h.resolveStaleHours({ STALE_PENDING_HOURS: 'x' }), h.DEFAULT_STALE_HOURS);
});

import { createRequire as __cr2 } from 'node:module';
import { test as __t2 } from 'node:test';
import __a2 from 'node:assert/strict';
__t2('BRO-2735: refetch rebuild keeps exclusion flags and score provenance', () => {
  const { buildRefetchedPendingRecord } = __cr2(import.meta.url)('./pending-review-health.js');
  const stub = { showId: 's', url: 'u', wrongProduction: true, wrongProductionNote: 'n', westEndTheatreScore: 4,
    aggregatorStars: 3, sources: ['x'], showScoreUrl: 'y', fullText: '', contentTier: 'stub', firstSeenAt: '2026-01-01T00:00:00Z' };
  const out = buildRefetchedPendingRecord(stub, { fullText: 'body text', contentTier: 'complete' }, '2026-02-01T00:00:00Z');
  __a2.equal(out.wrongProduction, true);
  __a2.equal(out.westEndTheatreScore, 4);
  __a2.deepEqual(out.sources, ['x']);
  __a2.equal(out.fullText, 'body text');
  __a2.equal(out.contentTier, 'complete');
  __a2.equal(out.firstSeenAt, '2026-01-01T00:00:00Z');
  __a2.equal(stub.fullText, '');
});
