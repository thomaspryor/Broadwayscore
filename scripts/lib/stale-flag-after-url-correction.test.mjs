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
// These tests exist so re-adding a drain is a RED TEST, not a quiet regression.
//
// The guard is BEHAVIOURAL, not name-based, deliberately. An earlier version
// matched export names against /^(remediate|fix|drain|clear)/i, which an
// adversarial review pointed out is trivially bypassed — `repairStaleFlags`,
// `applyStaleFlagCorrection` or `normalizeFlags` would all sail through while
// doing exactly the forbidden thing. Every export is now called against a
// record that matches the detector and asserted not to mutate it, so ANY
// mutating helper fails regardless of what it is called.
test('every export is non-mutating (no drain can be reintroduced under any name)', async () => {
  const mod = await import('./stale-flag-after-url-correction.js');
  const api = mod.default ?? mod;
  // A record the detector matches, i.e. exactly what a drain would target.
  // needsRefetch: true is REQUIRED in this fixture, not incidental — 107 of the
  // 115 real matches carry it, so a re-added drain gated on `needsRefetch ===
  // true` is the single most likely shape. A review proved that exact mutant
  // slipped through a fixture that omitted the field.
  const build = () => ({
    url: 'https://example.com/b',
    wrongProduction: true,
    wrongProductionNote: 'Pre-opening guard: pre-window date',
    wrongShow: true,
    wrongShowReason: 'title mismatch',
    contentVerification: { verified: false },
    contentTier: 'stub',
    fullText: null,
    needsRefetch: true,
    aggregatorStars: '4/5',
    _urlChangedClear: { from: 'https://example.com/a', to: 'https://example.com/b', cleared: ['fullText'] },
  });
  const FAIL = (name, how) =>
    `${name}() ${how}. This module must expose no bulk flag-clearing helper under any name: `
    + 'its matches are usually CORRECT flags, and clearing them re-admits wrong-production '
    + 'reviews into live Critic Scores. The remedy for these records is a refetch, never a '
    + 'flag-clear.';

  let checked = 0;
  for (const [name, fn] of Object.entries(api)) {
    if (typeof fn !== 'function') continue;
    checked++;
    const data = build();
    const before = JSON.stringify(data);
    // `await` so an async drain that mutates after a tick is still caught; the
    // try/catch keeps a signature-mismatch drain (fn(data, flags), fn(path))
    // failing with THIS message rather than a bare TypeError.
    let returned;
    try {
      returned = await fn(data);
    } catch (err) {
      assert.fail(FAIL(name, `threw on a matching record (${err.message})`));
    }
    assert.equal(JSON.stringify(data), before, FAIL(name, 'MUTATED a matching record'));
    // A drain need not mutate in place — returning a cleared COPY that the
    // caller writes back is just as destructive, and mutation-testing showed
    // that shape passing silently.
    if (returned && typeof returned === 'object' && !Array.isArray(returned)) {
      for (const flag of ['wrongProduction', 'wrongShow']) {
        if (data[flag] === true && returned[flag] !== true) {
          assert.fail(FAIL(name, `returned a COPY with ${flag} cleared`));
        }
      }
    }
  }
  assert.ok(checked >= 3, `expected to exercise the module's exported functions, checked ${checked}`);
});

test('the deleted remediate export specifically has not come back', async () => {
  const mod = await import('./stale-flag-after-url-correction.js');
  const api = mod.default ?? mod;
  assert.equal(api.remediateStaleFlagAfterUrlCorrection, undefined,
    'remediateStaleFlagAfterUrlCorrection was deleted 2026-08-14 — do not reintroduce it.');
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
