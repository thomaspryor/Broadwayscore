import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mergeTheatreRecordIntoExisting, isWrongShowRejection } = createRequire(import.meta.url)('./review-text-identity.js');

const rejected = () => ({
  fullText: 'Another production reviewed at length here. '.repeat(10),
  rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_show', wrongShow: true,
  rejectionReasoning: 'x', contentTier: 'invalid', contentTierReason: 'Wrong show', llmPullQuote: 'q',
});
const fresh = (t) => ({ fullText: t, contentTier: 'complete', contentTierReason: 'Full review text from Theatre Record', textFetchedAt: '2026-10-26T00:00:00Z' });

test('BRO-6154 wrong-show rejected file takes the fresh section text, lifts the rejection and requeues', () => {
  const out = mergeTheatreRecordIntoExisting(rejected(), fresh('The right production gets its own review text. '.repeat(10)));
  assert.match(out.fullText, /^The right production/);
  for (const k of ['wrongShow', 'rejectedBy', 'rejectionReason', 'rejectionReasoning', 'llmPullQuote']) assert.equal(out[k], undefined, k);
  assert.equal(out.contentTier, 'complete');
  assert.equal(out.needsRescore, true);
  assert.match(out.fullTextTrimmed.reason, /BRO-6154/);
});

test('BRO-6154 same text re-extracted keeps the rejection; non-rejected files are untouched', () => {
  const r = rejected();
  assert.equal(mergeTheatreRecordIntoExisting(r, fresh(r.fullText)).rejectedBy, 'ensemble-scoreability-check');
  const ok = { fullText: 'Good existing text. '.repeat(20), contentTier: 'complete' };
  assert.equal(mergeTheatreRecordIntoExisting(ok, fresh('Different. '.repeat(30))).fullText, ok.fullText);
  assert.equal(isWrongShowRejection({ rejectedBy: 'other', rejectionReason: 'wrong_show' }), false);
});

// BRO-6302: the merge lifted the rejection, but safeWriteReview's restore pass copied it back from disk.
test('BRO-6302 safeWriteReview honors the BRO-6154 lift (rejection is not resurrected from disk)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { safeWriteReview } = createRequire(import.meta.url)('./review-write-guard.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bro6302-')), 'x'); fs.mkdirSync(dir); const p = path.join(dir, 'standard--henry-hitchings.json');
  const old = { ...rejected(), showId: 'x', outletId: 'standard', criticName: 'Henry Hitchings', source: 'theatre-record', rejectedAt: '2026-10-22T00:00:00Z', fullText: 'The King and I is a musical about Siam. '.repeat(40) };
  fs.writeFileSync(p, JSON.stringify(old));
  const merged = mergeTheatreRecordIntoExisting(old, fresh('King Lear divides his kingdom and rages on the heath. '.repeat(40)));
  safeWriteReview(p, merged);
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of ['wrongShow', 'rejectedBy', 'rejectionReason', 'rejectedAt']) assert.equal(out[k], undefined, k);
  assert.match(out.fullText, /^King Lear/);
  assert.equal(out.needsRescore, true);
});
