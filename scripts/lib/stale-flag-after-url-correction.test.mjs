import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectStaleFlagAfterUrlCorrection, remediateStaleFlagAfterUrlCorrection } = require('./stale-flag-after-url-correction.js');

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
