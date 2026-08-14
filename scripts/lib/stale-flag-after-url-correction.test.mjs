import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectStaleFlagAfterUrlCorrection,
  remediateStaleFlagAfterUrlCorrection,
  isAwaitingUrlCorrectionRefetch,
  shouldWithholdStaleExclusionFlag,
} = require('./stale-flag-after-url-correction.js');

// --- producer/detector agreement (the drain→rebuild→re-flag loop) ---------
// The #483 gate stayed red for a day because the DRAIN and the RE-FLAGGER were
// different code: a human cleared 157 flags (review-texts 773ebb7189d) and the
// next Rebuild Reviews (Fast) run (a4246421ff0, ~4h later) put wrongProduction
// straight back with a "Date guard:" note, because flag-wrong-production-by-date.js
// never checked the URL-correction breadcrumb. These tests pin the shared
// predicate both sides now use, so the loop cannot reopen silently.

test('isAwaitingUrlCorrectionRefetch: true for a corrected URL whose body has not landed', () => {
  assert.equal(isAwaitingUrlCorrectionRefetch({
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: ['fullText'] },
  }), true);
});

test('isAwaitingUrlCorrectionRefetch: false once the refetched body lands', () => {
  assert.equal(isAwaitingUrlCorrectionRefetch({
    fullText: 'the refetched review body',
    _urlChangedClear: { from: 'a', to: 'b', cleared: ['fullText'] },
  }), false, 'body present means the record is evidence again — guards must resume');
});

test('isAwaitingUrlCorrectionRefetch: false with no URL-correction breadcrumb', () => {
  assert.equal(isAwaitingUrlCorrectionRefetch({ fullText: null }), false,
    'an ordinary empty record is NOT protected — only ones mid-URL-correction');
});

test('a freshly drained record is skippable by producers before the detector can rematch', () => {
  // Exactly the post-drain state: flags cleared, body still empty. The detector
  // no longer matches (nothing to clear) but the record is still not evidence,
  // so a date guard that re-derives a flag here recreates the gate failure.
  const drained = { fullText: null, _urlChangedClear: { from: 'a', to: 'b', cleared: ['fullText'] } };
  assert.deepEqual(detectStaleFlagAfterUrlCorrection(drained), [],
    'drained record is clean as far as the gate is concerned');
  assert.equal(isAwaitingUrlCorrectionRefetch(drained), true,
    'but producers must still skip it — this is the assertion that closes the loop');
});

test('flags the exact #483 signature: wrongProduction + breadcrumb + empty body + no manual clear', () => {
  const match = detectStaleFlagAfterUrlCorrection({
    wrongProduction: true,
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: ['fullText'] },
  });
  assert.deepEqual(match, ['wrongProduction']);
});

test('flags wrongShow the same way', () => {
  const match = detectStaleFlagAfterUrlCorrection({
    wrongShow: true,
    fullText: '',
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  });
  assert.deepEqual(match, ['wrongShow']);
});

test('flags BOTH wrongProduction and wrongShow when a record carries both', () => {
  const match = detectStaleFlagAfterUrlCorrection({
    wrongProduction: true,
    wrongShow: true,
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  });
  assert.deepEqual(match, ['wrongProduction', 'wrongShow']);
});

test('no match without an _urlChangedClear breadcrumb', () => {
  assert.deepEqual(detectStaleFlagAfterUrlCorrection({ wrongProduction: true, fullText: null }), []);
});

test('no match once the body is present (refetch completed)', () => {
  assert.deepEqual(detectStaleFlagAfterUrlCorrection({
    wrongProduction: true,
    fullText: 'a real review body',
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  }), []);
});

test('no match when a human manually cleared the flag', () => {
  assert.deepEqual(detectStaleFlagAfterUrlCorrection({
    wrongProduction: true,
    wrongProductionManualClear: true,
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  }), []);
});

test('no match when neither flag is set', () => {
  assert.deepEqual(detectStaleFlagAfterUrlCorrection({
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  }), []);
});

test('remediate clears wrongProduction + shared fields (contentVerification, contentTier) and extends the breadcrumb', () => {
  const data = {
    wrongProduction: true,
    wrongProductionReason: 'Pre-opening guard',
    contentVerification: { verified: false },
    contentTier: 'stub',
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: ['fullText'] },
  };
  const cleared = remediateStaleFlagAfterUrlCorrection(data);
  assert.ok(cleared.includes('wrongProduction'));
  assert.ok(cleared.includes('wrongProductionReason'));
  assert.ok(cleared.includes('contentVerification'));
  assert.ok(cleared.includes('contentTier'));
  assert.equal(data.wrongProduction, undefined);
  assert.equal(data.contentVerification, undefined);
  assert.equal(data.contentTier, undefined);
  assert.equal(data.needsRefetch, true);
  assert.ok(data._urlChangedClear.cleared.includes('fullText'));
  assert.ok(data._urlChangedClear.cleared.includes('wrongProduction'));
  assert.deepEqual(detectStaleFlagAfterUrlCorrection(data), [], 'remediated record must no longer match the detector');
});

test('remediate clears BOTH flag families in a single pass on a dual-flagged record', () => {
  const data = {
    wrongProduction: true,
    wrongProductionReason: 'Pre-opening guard',
    wrongShow: true,
    wrongShowReason: 'title mismatch',
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  };
  const cleared = remediateStaleFlagAfterUrlCorrection(data);
  assert.ok(cleared.includes('wrongProduction'));
  assert.ok(cleared.includes('wrongShow'));
  assert.equal(data.wrongProduction, undefined);
  assert.equal(data.wrongShow, undefined);
  assert.deepEqual(detectStaleFlagAfterUrlCorrection(data), [], 'a single remediate() call must clear a dual-flagged record completely');
});

test('remediate is a no-op for a non-matching record', () => {
  const data = { wrongProduction: true, fullText: 'a real body' };
  const cleared = remediateStaleFlagAfterUrlCorrection(data);
  assert.deepEqual(cleared, []);
  assert.equal(data.wrongProduction, true, 'non-matching record must be untouched');
});

// --- producer predicate must agree with the gate, by construction ----------
// shouldWithholdStaleExclusionFlag is what PRODUCERS call before persisting a
// new exclusion flag. It has to match detectStaleFlagAfterUrlCorrection's view
// exactly, or the two drift: a producer keyed on the bare
// isAwaitingUrlCorrectionRefetch withholds flags on operator-cleared records
// the gate never objected to — invisible, because "a flag that was not written"
// leaves no trace anywhere. That silent divergence is the same class of defect
// (an override set consulted with inverted meaning) that got the 2026-08-13
// write-guard attempt reverted.

test('shouldWithholdStaleExclusionFlag: true on a bare awaiting-refetch record', () => {
  assert.equal(shouldWithholdStaleExclusionFlag({
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  }), true);
});

test('shouldWithholdStaleExclusionFlag: false once the refetched body lands', () => {
  assert.equal(shouldWithholdStaleExclusionFlag({
    fullText: 'the refetched article',
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
  }), false, 'a record with a body is judgeable — producers must be free to flag it');
});

test('shouldWithholdStaleExclusionFlag: false with no URL-correction breadcrumb', () => {
  assert.equal(shouldWithholdStaleExclusionFlag({ fullText: null }), false);
});

for (const marker of [
  'wrongProductionManualClear',
  'wrongShowManualClear',
  'wrongProductionOverride',
  'urlManualOverride',
]) {
  test(`shouldWithholdStaleExclusionFlag: false when the operator marker ${marker} is set`, () => {
    const data = {
      fullText: null,
      _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
      [marker]: true,
    };
    assert.equal(shouldWithholdStaleExclusionFlag(data), false,
      `${marker} makes the gate ignore this record, so producers must not withhold on it either`);
  });
}

test('shouldWithholdStaleExclusionFlag: false when humanReviewedWrongProduction === false', () => {
  assert.equal(shouldWithholdStaleExclusionFlag({
    fullText: null,
    _urlChangedClear: { from: 'a', to: 'b', cleared: [] },
    humanReviewedWrongProduction: false,
  }), false);
});

test('producer predicate and gate agree on every operator-marker record', () => {
  // The invariant that matters: for any record the producer WITHHOLDS on,
  // writing the flag anyway would have made the gate match. Equivalently —
  // withhold === (gate would match once the flag is set).
  const markers = [null, 'wrongProductionManualClear', 'wrongShowManualClear',
    'wrongProductionOverride', 'urlManualOverride'];
  for (const marker of markers) {
    for (const body of [null, 'a real body']) {
      const base = { fullText: body, _urlChangedClear: { from: 'a', to: 'b', cleared: [] } };
      if (marker) base[marker] = true;
      const withheld = shouldWithholdStaleExclusionFlag(base);
      const gateWouldMatch =
        detectStaleFlagAfterUrlCorrection({ ...base, wrongProduction: true }).length > 0;
      assert.equal(withheld, gateWouldMatch,
        `disagreement for marker=${marker} body=${body ? 'present' : 'null'}: ` +
        `producer withhold=${withheld} but gate match=${gateWouldMatch}`);
    }
  }
});
