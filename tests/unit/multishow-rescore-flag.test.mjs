// BRO-5294: flag only complete, scored, unflagged rows for the section rescore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { flagMultiShowRescore, RESCORE_REASON } = require('../../scripts/lib/multishow-rescore-flag.js');
const COLUMN = 'x'.repeat(900) + ' Lyceum Theatre ($67-$137) ' + 'y'.repeat(900) + ' Lunt-Fontanne Theatre ($59-$150) ';
const base = () => ({ contentTier: 'complete', fullText: COLUMN, llmScore: { score: 80 } });

test('flags a complete scored row', () => {
  const d = base();
  assert.equal(flagMultiShowRescore(d, '2026-10-13T00:00:00Z').ok, true);
  assert.equal(d.needsRescore, true);
  assert.equal(d.rescoreReason, RESCORE_REASON);
  assert.equal(d.rescoreFlaggedAt, '2026-10-13T00:00:00Z');
});

test('refuses excluded, incomplete, unscored or human-locked rows', () => {
  for (const patch of [{ wrongAttribution: true }, { duplicateOf: 'x.json' }, { contentTier: 'truncated' }, { llmScore: null }, { humanReviewScore: 77 }, { fullText: 'x'.repeat(2000) + ' ($67-$137)' }]) {
    const d = { ...base(), ...patch };
    assert.equal(flagMultiShowRescore(d).ok, false, JSON.stringify(patch));
    assert.equal(d.needsRescore, undefined);
  }
});
