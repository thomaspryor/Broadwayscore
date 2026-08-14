import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectStaleFlagAfterUrlCorrection,
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

// --- the auto-remediation must STAY deleted --------------------------------
// remediateStaleFlagAfterUrlCorrection() cleared the exclusion-flag families on
// every detector match until 2026-08-14. It was removed because the detector's
// matches are overwhelmingly CORRECT flags: a URL "correction" can replace a
// correct article with a different production's, so the bodyless record really
// does warrant exclusion (verified on equus-west-end-2026/guardian--unknown.json,
// whose breadcrumb moved from the 2026 Menier review to a 2019 Stratford East
// one; 8/8 files examined in review were correctly flagged). Running the drain
// stripped 121 files and immediately reddened two independent CI gates — 59
// [wrong-production-by-date] errors and 5 zero-tolerance class-A cross-market
// leaks — with 100% of hits being drained files. 17 current matches carry
// aggregatorStars and score WITHOUT fullText, so clearing them puts a
// wrong-production review into live scoring.
// This test exists so re-adding the export is a RED TEST, not a quiet regression.
test('no auto-remediation export is reintroduced (the drain was a contamination tool)', async () => {
  const mod = await import('./stale-flag-after-url-correction.js');
  const exported = Object.keys(mod.default ?? mod);
  const drainLike = exported.filter((k) => /^(remediate|fix|drain|clear)/i.test(k));
  assert.deepEqual(
    drainLike,
    [],
    `This module must expose no bulk flag-clearing helper. Found: ${drainLike.join(', ')}. `
      + 'The remedy for these records is a refetch (107/115 already carry needsRefetch:true), never a flag-clear.'
  );
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
