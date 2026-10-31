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

test('BRO-6356 unchanged rejected TR text gets NO-RECORD without lifting or requeuing', () => {
  const r = { ...rejected(), source: 'theatre-record', theatreRecordUrl: 'https://www.theatrerecord.com/archive/volume/38/page/657' };
  for (const text of [r.fullText, r.fullText.replaceAll(' ', '\n'), r.fullText + 'A changed tail.']) {
    const out = mergeTheatreRecordIntoExisting(r, { ...fresh(text), theatreRecordUrl: r.theatreRecordUrl });
    assert.equal(out.trNoRecordForProduction?.reason, 'Theatre Record has no review by this outlet and critic under this production (BRO-6154)');
    assert.ok(Number.isFinite(Date.parse(out.trNoRecordForProduction.at)));
    assert.equal(out.fullText, r.fullText);
    assert.equal(out.rejectedBy, r.rejectedBy);
    assert.equal(out.wrongShow, true);
    assert.equal(out.needsRescore, undefined);
    assert.equal(r.trNoRecordForProduction, undefined, 'input is not mutated');
    const again = mergeTheatreRecordIntoExisting(out, fresh(text));
    assert.deepEqual(again.trNoRecordForProduction, out.trNoRecordForProduction);
    const lifted = mergeTheatreRecordIntoExisting(out, fresh('A corrected production has a different review. '.repeat(20)));
    assert.equal(lifted.trNoRecordForProduction, undefined);
    assert.equal(lifted.rejectedBy, undefined);
    assert.equal(lifted.needsRescore, true);
  }
});

test('BRO-6356 NO-RECORD requires existing rejected TR text and a nonempty re-extraction', () => {
  const r = { ...rejected(), source: 'theatre-record' };
  for (const existing of [
    { ...r, source: 'outlet' },
    { ...r, source: undefined },
    { ...r, rejectedBy: 'another-check' },
    { ...r, rejectionReason: 'stub' },
    { ...r, fullText: undefined },
  ]) {
    assert.equal(mergeTheatreRecordIntoExisting(existing, fresh(r.fullText)).trNoRecordForProduction, undefined);
  }
  assert.equal(mergeTheatreRecordIntoExisting(r, fresh('')).trNoRecordForProduction, undefined);
});

test('BRO-6356 safeWriteReview persists NO-RECORD on a merged rejected file', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { safeWriteReview } = createRequire(import.meta.url)('./review-write-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6356-'));
  try {
    const showDir = path.join(dir, 'king-lear-west-end-2018');
    fs.mkdirSync(showDir);
    const p = path.join(showDir, 'telegraph--dominic-cavendish.json');
    const r = { ...rejected(), source: 'theatre-record', showId: 'king-lear-west-end-2018', outletId: 'telegraph', criticName: 'Dominic Cavendish' };
    fs.writeFileSync(p, JSON.stringify(r));
    safeWriteReview(p, mergeTheatreRecordIntoExisting(r, fresh(r.fullText)));
    const out = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.match(out.trNoRecordForProduction?.reason || '', /BRO-6154/);
    assert.equal(out.rejectionReason, 'wrong_show');
    assert.equal(out.fullText, r.fullText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('BRO-6302 a second lift works, a stale breadcrumb never re-clears a later re-flag, stuck flags go with the lift', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { safeWriteReview } = createRequire(import.meta.url)('./review-write-guard.js');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bro6302b-')), 'x'); fs.mkdirSync(dir); const p = path.join(dir, 'standard--henry-hitchings.json');
  const base = { ...rejected(), showId: 'x', outletId: 'standard', criticName: 'Henry Hitchings', source: 'theatre-record', stuckRescoreCleared: true, stuckRescoreClearedAt: '2026-10-20T00:00:00Z' };
  fs.writeFileSync(p, JSON.stringify(base));
  const lift1 = mergeTheatreRecordIntoExisting(base, fresh('First right text about Lear. '.repeat(40)));
  safeWriteReview(p, lift1);
  let out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(out.stuckRescoreCleared, undefined);
  // scorer re-rejects, then a later write without the flags must not clear them
  fs.writeFileSync(p, JSON.stringify({ ...out, wrongShow: true, rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_show' }));
  safeWriteReview(p, { ...out });
  out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(out.rejectionReason, 'wrong_show');
  // a fresh second lift (newer stamp) clears again
  const lift2 = mergeTheatreRecordIntoExisting(out, fresh('Second different right text about Lear. '.repeat(40)));
  lift2.fullTextTrimmed.at = new Date(Date.now() + 60000).toISOString();
  safeWriteReview(p, lift2);
  out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(out.rejectionReason, undefined);
  assert.equal(out.wrongShow, undefined);
});

// BRO-6302: the NO-RECORD stamp also covers rejected files taken from a
// different TR page, but only when the link is the show's own per-show pick.
test('BRO-6302 isTrNoRecordCandidate: same link, stale link only with picked', () => {
  const { isTrNoRecordCandidate } = createRequire(import.meta.url)('./review-text-identity.js');
  const rej = { source: 'theatre-record', rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_show' };
  const A = 'https://www.theatrerecord.com/archive/volume/39/dest/4_come_from_away';
  const B = 'https://www.theatrerecord.com/archive/volume/41/dest/14_come_from_away';
  assert.equal(isTrNoRecordCandidate({ ...rej, theatreRecordUrl: A }, A), true);
  assert.equal(isTrNoRecordCandidate({ ...rej, theatreRecordUrl: B }, A), false);
  assert.equal(isTrNoRecordCandidate({ ...rej, theatreRecordUrl: B }, A, { picked: true }), true);
  assert.equal(isTrNoRecordCandidate({ ...rej }, A, { picked: true }), false);
  assert.equal(isTrNoRecordCandidate({ ...rej, theatreRecordUrl: A, trNoRecordForProduction: { reason: 'x' } }, A), false);
  assert.equal(isTrNoRecordCandidate({ ...rej, source: 'outlet', theatreRecordUrl: A }, A, { picked: true }), false);
  assert.equal(isTrNoRecordCandidate({ ...rej, rejectionReason: 'stub', theatreRecordUrl: A }, A, { picked: true }), false);
});

// BRO-6365: PDFs that parse to 0 reviews for a picked production still stamp NO-RECORD.
test('BRO-6365 shouldSweepNoRecord: parsed-empty picked PDF sweeps; failures and browse matches do not', () => {
  const { shouldSweepNoRecord } = createRequire(import.meta.url)('./review-text-identity.js');
  assert.equal(shouldSweepNoRecord({ reviewCount: 3 }), true);
  assert.equal(shouldSweepNoRecord({ reviewCount: 0, picked: true, isPDF: true, parsedOk: true }), true);
  assert.equal(shouldSweepNoRecord({ reviewCount: 0, picked: true, isPDF: true, parsedOk: false }), false);
  assert.equal(shouldSweepNoRecord({ reviewCount: 0, picked: false, isPDF: true, parsedOk: true }), false);
  assert.equal(shouldSweepNoRecord({ reviewCount: 0, picked: true, isPDF: false, parsedOk: true }), false);
});
