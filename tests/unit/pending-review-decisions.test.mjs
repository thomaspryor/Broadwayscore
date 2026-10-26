// BRO-6336: reviewed pending entries move to the archive with outcome and reason. require()s the real module (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { applyDecisions, decisionProblems } = require('../../scripts/lib/pending-review-decisions');

const NOW = '2026-10-26T12:00:00.000Z';
const fresh = () => ({
  pending: { shows: { 'a-2024': { capitalization: 5, recoupedSource: 'x' }, b: { capitalization: null } }, lastUpdated: 'old' },
  archive: { shows: {}, lastUpdated: 'old' },
});

test('moves decided entries to the archive under the slug, keeps the rest', () => {
  const { pending, archive } = fresh();
  const res = applyDecisions({
    pending, archive, now: NOW, reviewedBy: 'BRO-6336', slugFor: (k) => k.replace(/-2024$/, ''),
    decisions: { 'a-2024': { outcome: 'rejected', reason: 'figure not on the cited page' } },
  });
  assert.deepEqual(res, { moved: 1, counts: { rejected: 1 } });
  assert.deepEqual(Object.keys(pending.shows), ['b']);
  assert.equal(pending.lastUpdated, NOW);
  const rec = archive.shows.a;
  assert.equal(rec.pendingKey, 'a-2024');
  assert.equal(rec.archivedReason, 'reviewed-rejected');
  assert.equal(rec.archivedDetail, 'figure not on the cited page');
  assert.equal(rec.capitalization, 5);
  assert.equal(rec.reviewedBy, 'BRO-6336');
});

test('refuses unknown keys, bad outcomes and thin reasons before changing anything', () => {
  const { pending, archive } = fresh();
  const decisions = { nope: { outcome: 'rejected', reason: 'a long enough reason' }, b: { outcome: 'maybe', reason: 'a long enough reason' }, 'a-2024': { outcome: 'duplicate', reason: 'short' } };
  assert.equal(decisionProblems(pending, decisions).length, 3);
  assert.throws(() => applyDecisions({ pending, archive, decisions, slugFor: (k) => k }), /not in the pending file/);
  assert.equal(Object.keys(pending.shows).length, 2);
  assert.deepEqual(archive.shows, {});
});
