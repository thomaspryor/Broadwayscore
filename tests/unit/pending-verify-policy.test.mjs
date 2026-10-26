// BRO-6336: an any-confidence entry whose quoted figure verifies on the fetched page applies with no human step;
// unconfirmed ones are rejected with a reason; unverifiable items reach the owner digest exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { verifiedOutcome } = require('../../scripts/lib/pending-verify-policy');
const { verifyFigure, showTitleForms } = require('../../scripts/lib/commercial-source-verify');
const { collectUnsent, buildDigest, markSent } = require('../../scripts/lib/unverified-digest');

const page = '<html><head><title>Lear Capitalization</title></head><body><h1>King Lear</h1><p>The 2019 production of King Lear was capitalized at $4.9 million, Forbes reported.</p></body></html>';
const evidenceFor = (entry) => {
  const ev = {};
  const r = verifyFigure(entry.capitalization, page, { titles: showTitleForms('King Lear'), year: '2019', field: 'capitalization' });
  if (r.found) ev.capitalization = r;
  return ev;
};

test('a LOW-confidence entry whose figure the page confirms applies', () => {
  const entry = { confidence: 'low', capitalization: 4900000 };
  const ev = evidenceFor(entry);
  assert.ok(ev.capitalization, 'the verifier found the quote');
  assert.deepEqual(verifiedOutcome(entry, ev), { action: 'apply' });
});

test('a figure the page does not state is rejected with a reason, not applied', () => {
  const entry = { confidence: 'high', capitalization: 6000000 };
  const out = verifiedOutcome(entry, evidenceFor(entry));
  assert.equal(out.action, 'reject');
  assert.match(out.reason, /capitalization/);
});

test('fetch failures retry, then reject on the last attempt', () => {
  const entry = { capitalization: 4900000 };
  assert.equal(verifiedOutcome(entry, { fetchFailed: true }).action, 'retry');
  const last = verifiedOutcome({ ...entry, sourceVerifyAttempts: 2 }, { fetchFailed: true });
  assert.equal(last.action, 'reject');
  assert.match(last.reason, /could not be fetched/);
});

test('cap defers, and an entry with no figure to check falls through to the normal guards', () => {
  assert.equal(verifiedOutcome({ capitalization: 1 }, { capped: true }).action, 'defer');
  assert.equal(verifiedOutcome({ recouped: false }, {}).action, 'apply');
});

test('an unverifiable item makes exactly one digest entry and is marked sent', () => {
  const archive = { shows: { 'unverified:x-2024': { pendingKey: 'x-2024', archivedReason: 'unverified-figure', archivedDetail: 'no trusted cited page states the capitalization figure', capitalization: 8000000, sources: [{ url: 'https://example.com/a' }], ownerDigestSentAt: null } } };
  const pending = { shows: { y: { autoApplyBlocked: 'recoupment claim: a person must confirm it', recouped: true, recoupedSource: 'see https://example.com/b.' } } };
  const items = collectUnsent({ pending, archive });
  assert.equal(items.length, 2);
  const d = buildDigest(items);
  assert.match(d.description, /x-2024: capitalization \$8\.0M/);
  assert.match(d.description, /https:\/\/example\.com\/b\b/);
  markSent({ pending, archive }, items, '2026-10-26T00:00:00Z');
  assert.equal(collectUnsent({ pending, archive }).length, 0);
  assert.equal(buildDigest([]), null);
});
